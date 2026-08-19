import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { asc, eq, inArray } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import { mailAccounts, type MailAccountRow } from '../../database/schema';

/** One mailbox as the console sees it. */
export interface MailAccountView {
  address: string;
  label: string | null;
  /** A locked mailbox cannot be deleted from here. */
  locked: boolean;
  createdAt: string | null;
  /** False when the address is in our table but missing from the mailserver. */
  live: boolean;
}

/**
 * Staff mailboxes on the platform's own mail domain, managed from the
 * platform-admin console.
 *
 * The mailserver (docker-mailserver) keeps its accounts in a flat file:
 * one `address|{SCHEME}hash` per line. That file is the account store and
 * this service edits it directly - no shell-out, and above all no Docker
 * socket, which would hand this container effective root on the host in
 * exchange for a convenience.
 *
 * Two details matter more than they look:
 *
 *   - **Writes are atomic.** The mailserver watches this file and rebuilds
 *     its Dovecot/Postfix config when it changes, so it must never observe a
 *     half-written one. Every change is written to a temp file in the same
 *     directory and renamed over the original, which is atomic on POSIX and
 *     needs write permission on the *directory*, not the file - so the
 *     mailserver can keep owning the file as root.
 *
 *   - **Passwords are hashed here and never stored.** Dovecot accepts
 *     bcrypt as `{BLF-CRYPT}`, which is what this project already hashes
 *     user passwords with, so no crypt(3) dependency is needed. The plaintext
 *     is returned to the operator exactly once, in the response that created
 *     it, and is never written to our database or logs.
 */
@Injectable()
export class MailAccountsService {
  private readonly logger = new Logger(MailAccountsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly config: ConfigService,
  ) {}

  private get accountsFile(): string {
    return this.config.get<string>('mail.accountsFile') ?? '';
  }

  /** The one domain this console may create mailboxes on. */
  private get domain(): string {
    return (this.config.get<string>('mail.domain') ?? '').toLowerCase();
  }

  /**
   * Whether mailbox management is wired up at all. False when the API has no
   * accounts file mounted, which is the normal state in development - the
   * console then says so rather than failing every call.
   */
  async isConfigured(): Promise<boolean> {
    const file = this.accountsFile;
    if (!file || !this.domain) return false;
    try {
      await access(file, fsConstants.R_OK);
      // Renaming over the file needs the directory writable, not the file.
      await access(dirname(file), fsConstants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  private async requireConfigured(): Promise<string> {
    if (!(await this.isConfigured())) {
      throw new ServiceUnavailableException(
        'Mailbox management is not available on this server - the mail accounts file is not mounted.',
      );
    }
    return this.accountsFile;
  }

  /* ── The mailserver's account file ─────────────────────────────── */

  /** Parsed `address|hash` lines, in file order. Blank lines are dropped. */
  private async readFileAccounts(): Promise<
    { address: string; hash: string }[]
  > {
    const raw = await readFile(await this.requireConfigured(), 'utf8');
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const at = line.indexOf('|');
        return at === -1
          ? { address: line.toLowerCase(), hash: '' }
          : {
              address: line.slice(0, at).trim().toLowerCase(),
              hash: line.slice(at + 1).trim(),
            };
      })
      .filter((a) => a.address);
  }

  /**
   * Replace the account file. Written to a temp file alongside it and renamed
   * over the top, so the mailserver watching this path only ever sees a
   * complete file - never a truncated one mid-write.
   */
  private async writeFileAccounts(
    entries: { address: string; hash: string }[],
  ): Promise<void> {
    const file = await this.requireConfigured();
    const body = entries.map((e) => `${e.address}|${e.hash}`).join('\n') + '\n';
    const temp = join(
      dirname(file),
      `.postfix-accounts.${randomBytes(6).toString('hex')}.tmp`,
    );
    try {
      // 0640 while it is a temp file; the rename carries the mode across.
      await writeFile(temp, body, { encoding: 'utf8', mode: 0o644 });
      await rename(temp, file);
    } catch (err) {
      await unlink(temp).catch(() => undefined);
      this.logger.error('Could not write the mail accounts file', err as Error);
      throw new ServiceUnavailableException(
        'Could not update the mailserver right now - please try again.',
      );
    }
  }

  /* ── Listing ───────────────────────────────────────────────────── */

  /**
   * Every mailbox on the server, with what this console knows about it.
   *
   * Reconciles as it goes: an address in the file with no row of ours gets
   * one, locked. That is what protects the mailboxes that came with the
   * server - nobody has to remember to name them - and it does the same for
   * anything added over SSH afterwards.
   */
  async list(): Promise<MailAccountView[]> {
    const onServer = await this.readFileAccounts();
    const known = await this.db.query.mailAccounts.findMany({
      orderBy: [asc(mailAccounts.address)],
    });
    const byAddress = new Map(known.map((r) => [r.address, r]));

    const unknown = onServer
      .filter((a) => !byAddress.has(a.address))
      .map((a) => ({ address: a.address, locked: true }));
    if (unknown.length) {
      const created = await this.db
        .insert(mailAccounts)
        .values(unknown)
        .onConflictDoNothing({ target: mailAccounts.address })
        .returning();
      for (const row of created) byAddress.set(row.address, row);
      this.logger.log(
        `Adopted ${created.length} pre-existing mailbox(es) as locked`,
      );
    }

    const live = new Set(onServer.map((a) => a.address));
    // A row of ours whose mailbox has vanished from the file still shows, so
    // the drift is visible rather than silently swallowed.
    const rows = [...byAddress.values()].sort((a, b) =>
      a.address.localeCompare(b.address),
    );
    return rows.map((row) => this.view(row, live.has(row.address)));
  }

  private view(row: MailAccountRow, live: boolean): MailAccountView {
    return {
      address: row.address,
      label: row.label,
      locked: row.locked,
      createdAt: row.createdAt.toISOString(),
      live,
    };
  }

  /* ── Create ────────────────────────────────────────────────────── */

  /**
   * Add a mailbox. Returns the password exactly once - it is hashed into the
   * mailserver's file and never stored by us, so this response is the only
   * time anyone can read it.
   */
  async create(input: {
    localPart: string;
    password?: string;
    label?: string;
  }): Promise<{ account: MailAccountView; password: string }> {
    await this.requireConfigured();
    const address = this.buildAddress(input.localPart);
    const password = input.password?.trim() || generatePassword();
    if (password.length < 12) {
      throw new BadRequestException(
        'Use a password of at least 12 characters.',
      );
    }

    const onServer = await this.readFileAccounts();
    if (onServer.some((a) => a.address === address)) {
      throw new ConflictException(`${address} already exists.`);
    }

    // Dovecot reads bcrypt as {BLF-CRYPT}, so the project's existing hashing
    // is reused rather than pulling in a crypt(3) implementation.
    const hash = `{BLF-CRYPT}${await bcrypt.hash(password, 10)}`;
    await this.writeFileAccounts([...onServer, { address, hash }]);

    const [row] = await this.db
      .insert(mailAccounts)
      .values({ address, label: input.label?.trim() || null, locked: false })
      .onConflictDoUpdate({
        target: mailAccounts.address,
        // A row can survive its mailbox (deleted outside the console, then
        // re-created here) - reuse it rather than colliding.
        set: { label: input.label?.trim() || null, locked: false },
      })
      .returning();

    this.logger.log(`Created mailbox ${address}`);
    return { account: this.view(row, true), password };
  }

  /* ── Delete ────────────────────────────────────────────────────── */

  /**
   * Remove a mailbox from the mailserver. Locked ones are refused: those are
   * the boxes that came with the server or were added outside this console,
   * including the address the platform sends its own mail from.
   *
   * The stored mail is deliberately left on disk. Dropping the account stops
   * delivery and login immediately, which is what removing a leaver needs;
   * destroying their maildir is a separate, irreversible decision and not one
   * a console button should quietly make.
   */
  async remove(address: string): Promise<{ address: string }> {
    await this.requireConfigured();
    const wanted = address.trim().toLowerCase();
    const row = await this.db.query.mailAccounts.findFirst({
      where: eq(mailAccounts.address, wanted),
    });
    if (!row) throw new NotFoundException('No such mailbox.');
    if (row.locked) {
      throw new ConflictException(
        `${wanted} is locked and cannot be deleted from here.`,
      );
    }
    if (this.isProtected(wanted)) {
      throw new ConflictException(
        `${wanted} is the address the platform sends its own mail from and cannot be deleted.`,
      );
    }

    const onServer = await this.readFileAccounts();
    const remaining = onServer.filter((a) => a.address !== wanted);
    if (remaining.length !== onServer.length) {
      await this.writeFileAccounts(remaining);
    }
    await this.db.delete(mailAccounts).where(eq(mailAccounts.id, row.id));

    this.logger.log(`Deleted mailbox ${wanted}`);
    return { address: wanted };
  }

  /* ── Password reset ────────────────────────────────────────────── */

  /**
   * Set a new password on an existing mailbox, locked ones included: being
   * undeletable is not a reason to be unrecoverable, and `support@` is
   * exactly the kind of shared box whose password needs rotating.
   */
  async resetPassword(
    address: string,
    password?: string,
  ): Promise<{ address: string; password: string }> {
    await this.requireConfigured();
    const wanted = address.trim().toLowerCase();
    const next = password?.trim() || generatePassword();
    if (next.length < 12) {
      throw new BadRequestException(
        'Use a password of at least 12 characters.',
      );
    }

    const onServer = await this.readFileAccounts();
    if (!onServer.some((a) => a.address === wanted)) {
      throw new NotFoundException('No such mailbox on the mailserver.');
    }
    const hash = `{BLF-CRYPT}${await bcrypt.hash(next, 10)}`;
    await this.writeFileAccounts(
      onServer.map((a) => (a.address === wanted ? { ...a, hash } : a)),
    );

    this.logger.log(`Reset the password on ${wanted}`);
    return { address: wanted, password: next };
  }

  /** Rename the console's label for a mailbox. Never touches the mailserver. */
  async setLabel(address: string, label: string | null): Promise<void> {
    const wanted = address.trim().toLowerCase();
    await this.db
      .update(mailAccounts)
      .set({ label: label?.trim() || null })
      .where(eq(mailAccounts.address, wanted));
  }

  /* ── Internals ─────────────────────────────────────────────────── */

  /**
   * Build and validate the full address. Only the platform's own domain is
   * accepted: this console exists to make staff mailboxes, and letting it
   * name any domain would turn it into a way to add accounts the mailserver
   * was never meant to answer for.
   */
  private buildAddress(localPart: string): string {
    const local = localPart.trim().toLowerCase();
    if (!this.domain) {
      throw new ServiceUnavailableException(
        'No mail domain is configured on this server.',
      );
    }
    // Postfix accepts more than this, but a staff mailbox has no business
    // needing quoted or dotted-edge local parts, and the file format itself
    // reserves '|'.
    if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(local)) {
      throw new BadRequestException(
        'Use letters, numbers, dots, dashes and underscores - starting and ending with a letter or number.',
      );
    }
    return `${local}@${this.domain}`;
  }

  /** The address the platform itself sends from - never removable. */
  private isProtected(address: string): boolean {
    const from = this.config.get<string>('mail.from') ?? '';
    const match = /<([^>]+)>/.exec(from);
    const sender = (match ? match[1] : from).trim().toLowerCase();
    return !!sender && sender === address;
  }

  /** Addresses that already exist, for the console's duplicate hinting. */
  async addressesInUse(): Promise<string[]> {
    const rows = await this.db
      .select({ address: mailAccounts.address })
      .from(mailAccounts)
      .where(inArray(mailAccounts.locked, [true, false]));
    return rows.map((r) => r.address);
  }
}

/**
 * A readable but strong generated password: five groups of four from an
 * alphabet with the characters people misread taken out, so an operator can
 * hand it over verbally without a spelling argument.
 */
function generatePassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(20);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]);
  return [0, 4, 8, 12, 16].map((i) => chars.slice(i, i + 4).join('')).join('-');
}
