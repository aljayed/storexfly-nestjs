import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MailAccountsService } from './mail-accounts.service';
import type { MailAccountRow } from '../../database/schema';

/**
 * Drizzle's `eq(col, value)` builds an SQL object, not a string, so the fake
 * digs the address back out of it rather than pretending the where clause is
 * one. Keeps the production code honest instead of reshaping it for a test.
 */
function addressInWhere(where: unknown): string | undefined {
  const seen: string[] = [];
  const walk = (node: unknown, depth = 0): void => {
    if (node == null || depth > 8) return;
    if (typeof node === 'string') return void seen.push(node);
    if (Array.isArray(node))
      return void node.forEach((n) => walk(n, depth + 1));
    if (typeof node === 'object') {
      for (const value of Object.values(node)) walk(value, depth + 1);
    }
  };
  walk(where);
  return seen.find((v) => v.includes('@'));
}

/**
 * This service edits the file Dovecot authenticates against, so two rules
 * carry real weight:
 *
 *   - the mailboxes that came with the server cannot be deleted from the
 *     console, and nobody has to remember to name them - they are locked by
 *     virtue of not having been created here;
 *   - a write either lands whole or not at all, and never disturbs the other
 *     accounts' password hashes.
 *
 * Getting the first wrong loses a company's mail. Getting the second wrong
 * locks every employee out at once.
 */
describe('MailAccountsService', () => {
  const DOMAIN = 'hoomri.com';
  const EXISTING = [
    'support@hoomri.com|{SHA512-CRYPT}$6$aaa$supporthash',
    'no-reply@hoomri.com|{SHA512-CRYPT}$6$bbb$noreplyhash',
    'contact@hoomri.com|{SHA512-CRYPT}$6$ccc$contacthash',
  ].join('\n');

  /** A file on disk plus an in-memory stand-in for the metadata table. */
  async function harness(fileBody = EXISTING) {
    const dir = await mkdtemp(join(tmpdir(), 'mailaccounts-'));
    const file = join(dir, 'postfix-accounts.cf');
    await writeFile(file, fileBody + '\n', 'utf8');

    const rows: MailAccountRow[] = [];
    const row = (address: string, locked: boolean): MailAccountRow => ({
      id: `id-${address}`,
      address,
      label: null,
      locked,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const db = {
      query: {
        mailAccounts: {
          findMany: () => Promise.resolve([...rows]),
          findFirst: ({ where }: { where: unknown }) => {
            const address = addressInWhere(where);
            return Promise.resolve(
              rows.find((r) => r.address === address) ?? undefined,
            );
          },
        },
      },
      insert: () => ({
        values: (vals: { address: string; locked?: boolean }[]) => {
          const list = Array.isArray(vals) ? vals : [vals];
          const made = list.map((v) => row(v.address, v.locked ?? false));
          return {
            onConflictDoNothing: () => ({
              returning: () => {
                made.forEach((m) => rows.push(m));
                return Promise.resolve(made);
              },
            }),
            onConflictDoUpdate: () => ({
              returning: () => {
                made.forEach((m) => rows.push(m));
                return Promise.resolve(made);
              },
            }),
          };
        },
      }),
      delete: () => ({
        where: (where: unknown) => {
          const id = addressInWhere(where);
          const keep = rows.filter((r) => r.id !== id && r.address !== id);
          rows.splice(0, rows.length, ...keep);
          return Promise.resolve();
        },
      }),
      update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
      select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
    };

    const config = {
      get: (key: string) =>
        ({
          'mail.accountsFile': file,
          'mail.domain': DOMAIN,
          'mail.from': 'Hoomri <no-reply@hoomri.com>',
        })[key],
    };

    const service = new MailAccountsService(db as never, config as never);
    const read = async () =>
      (await readFile(file, 'utf8')).split('\n').filter(Boolean);
    return { service, read, rows, file };
  }

  it('adopts the mailboxes that came with the server as locked', async () => {
    const { service } = await harness();
    const list = await service.list();
    expect(list.map((a) => a.address)).toEqual([
      'contact@hoomri.com',
      'no-reply@hoomri.com',
      'support@hoomri.com',
    ]);
    expect(list.every((a) => a.locked)).toBe(true);
  });

  it('refuses to delete a locked mailbox', async () => {
    const { service, read } = await harness();
    await service.list(); // adopts them
    await expect(service.remove('support@hoomri.com')).rejects.toThrow(
      /locked/i,
    );
    // And the file is untouched - a refused delete must not half-happen.
    expect(await read()).toHaveLength(3);
  });

  it('creates a mailbox without disturbing the existing hashes', async () => {
    const { service, read } = await harness();
    const { account, password } = await service.create({ localPart: 'ops' });

    expect(account.address).toBe('ops@hoomri.com');
    expect(account.locked).toBe(false);
    expect(password.length).toBeGreaterThanOrEqual(12);

    const lines = await read();
    expect(lines).toHaveLength(4);
    // Every original line survives byte for byte.
    for (const original of EXISTING.split('\n')) {
      expect(lines).toContain(original);
    }
    // The new one is bcrypt, which Dovecot reads as {BLF-CRYPT}.
    const added = lines.find((l) => l.startsWith('ops@'));
    expect(added).toMatch(/^ops@hoomri\.com\|\{BLF-CRYPT\}\$2[aby]\$/);
  });

  it('deletes only the mailbox asked for, once it is unlocked', async () => {
    const { service, read, rows } = await harness();
    await service.create({ localPart: 'ops' });
    // The row create() made is unlocked, which is what makes it removable.
    expect(rows.find((r) => r.address === 'ops@hoomri.com')?.locked).toBe(
      false,
    );

    await service.remove('ops@hoomri.com');
    const lines = await read();
    expect(lines).toHaveLength(3);
    expect(lines.some((l) => l.startsWith('ops@'))).toBe(false);
  });

  // The address the platform sends its own mail from is refused even if its
  // lock were somehow cleared - losing it would silence every notification.
  it('never deletes the platform sender address', async () => {
    const { service } = await harness();
    await service.list();
    await expect(service.remove('no-reply@hoomri.com')).rejects.toThrow();
  });

  it('only creates addresses on the platform domain', async () => {
    const { service } = await harness();
    await expect(
      service.create({ localPart: 'ops@evil.com' }),
    ).rejects.toThrow();
    await expect(service.create({ localPart: '-bad' })).rejects.toThrow();
    await expect(service.create({ localPart: 'a|b' })).rejects.toThrow();
  });

  it('rejects a password too short to be worth setting', async () => {
    const { service } = await harness();
    await expect(
      service.create({ localPart: 'ops', password: 'short' }),
    ).rejects.toThrow(/12 characters/);
  });

  it('reports itself unavailable when no accounts file is mounted', async () => {
    const service = new MailAccountsService(
      {} as never,
      { get: () => '' } as never,
    );
    await expect(service.isConfigured()).resolves.toBe(false);
  });
});
