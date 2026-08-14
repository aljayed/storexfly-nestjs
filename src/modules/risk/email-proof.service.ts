import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomBytes } from 'crypto';
import { EmailOtpService } from '../auth/email-otp.service';
import { MailService } from '../mail/mail.service';
import { UsersService } from '../users/users.service';

const SCOPE = 'checkout-email';
/** Long enough to finish a checkout, short enough that a proof is not reusable
 *  tomorrow if it leaks out of a shared browser. Matches the phone proof. */
const PROOF_TTL = '20m';
/** A pending verification outlives the code slightly, so the tab that started
 *  it can still collect a proof from a link clicked at the last moment. */
const PENDING_TTL_MS = 15 * 60 * 1000;

interface EmailProofClaims {
  typ: 'email-proof';
  email: string;
}

/**
 * A verification in flight. `pendingId` goes to the tab that started it and is
 * never emailed; `linkToken` is emailed and never returned to the tab. Two
 * separate secrets for two separate holders, so collecting a proof by polling
 * requires having started the flow, and following the link requires the inbox.
 */
interface Pending {
  email: string;
  accountId: string | null;
  linkToken: string;
  expiresAt: number;
  /** Minted when the emailed link is followed, and handed to the next poll. */
  proof?: string;
}

export function normalizeEmail(raw: string | null | undefined): string {
  return (raw ?? '').trim().toLowerCase();
}

/**
 * Email verification for people who may have no account to hang it off.
 *
 * Mirrors {@link PhoneProofService}: a guest cannot "verify their email" the
 * way a signed-in account does - there is no row to mark - so answering the
 * code mints a short-lived signed proof instead, which checkout accepts in
 * place of a verified account. The proof names the address it was issued for,
 * so it cannot be replayed against a different one.
 *
 * Two ways to answer, because an inbox is not always on the device holding the
 * checkout: type the six digits, or follow the link. The link is what makes a
 * phone-in-hand, laptop-on-desk buyer possible, and it is why the tab polls -
 * see {@link collect}.
 */
@Injectable()
export class EmailProofService {
  private readonly logger = new Logger(EmailProofService.name);
  private readonly secret: string;
  private readonly webUrl: string;
  /**
   * In-memory, like the OTP stores this sits beside - swap for Redis in
   * production so a restart does not strand a buyer mid-verification and the
   * link works across instances.
   */
  private readonly pendings = new Map<string, Pending>();
  private readonly byLinkToken = new Map<string, string>();
  private readonly isProduction = process.env.NODE_ENV === 'production';

  constructor(
    private readonly emailOtp: EmailOtpService,
    private readonly mail: MailService,
    private readonly jwt: JwtService,
    private readonly users: UsersService,
    config: ConfigService,
  ) {
    this.secret = config.getOrThrow<string>('jwt.secret');
    this.webUrl = config.get<string>('app.webUrl') ?? 'http://localhost:5173';
  }

  /**
   * Email a code and a link to the address the checkout is using.
   *
   * Returns the `pendingId` the tab polls with. Re-starting for the same
   * address reuses the live pending record, so asking for a resend does not
   * strand the link already sitting in the inbox.
   */
  async start(
    rawEmail: string,
    accountId?: string | null,
  ): Promise<{
    pendingId: string;
    retryAfterSeconds: number;
    /** Reference behaviour only - see the return below. */
    devCode?: string;
    devLink?: string;
  }> {
    const email = normalizeEmail(rawEmail);
    if (!email.includes('@')) {
      throw new BadRequestException('Enter a valid email address');
    }
    this.sweep();

    const existing = this.findLivePending(email);
    const pendingId = existing?.id ?? randomBytes(18).toString('base64url');
    const linkToken =
      existing?.pending.linkToken ?? randomBytes(32).toString('base64url');

    this.pendings.set(pendingId, {
      email,
      // A later start from a signed-in tab upgrades the record, so following
      // the link also marks the account - never the reverse.
      accountId: accountId ?? existing?.pending.accountId ?? null,
      linkToken,
      expiresAt: Date.now() + PENDING_TTL_MS,
    });
    this.byLinkToken.set(linkToken, pendingId);

    const url = `${this.webUrl.replace(/\/+$/, '')}/verify-email?token=${encodeURIComponent(linkToken)}`;
    const dispatch = await this.emailOtp.start<{ pendingId: string }>(
      SCOPE,
      email,
      { pendingId },
      {
        subject: 'Confirm your email to pay',
        heading: 'Confirm your email',
        intro: 'Enter this code to confirm your email and continue your payment:',
        linkUrl: url,
        linkLabel: 'Confirm my email',
      },
    );
    return {
      pendingId,
      retryAfterSeconds: dispatch.retryAfterSeconds,
      // Same bargain the phone flow strikes: with no mail server configured the
      // code would be unreachable and the whole step a wall with no door, so
      // locally it comes back in the response. Never in production, where this
      // endpoint is public and handing out the code would make the check
      // ornamental.
      ...(this.mail.canDeliver || this.isProduction
        ? {}
        : { devCode: dispatch.code, devLink: url }),
    };
  }

  /** Exchange a correct code for the proof checkout accepts. */
  async confirmCode(
    rawEmail: string,
    code: string,
    accountId?: string | null,
  ): Promise<{ proof: string }> {
    const email = normalizeEmail(rawEmail);
    const pending = this.emailOtp.verify<{ pendingId: string }>(
      SCOPE,
      email,
      code,
    );
    if (!pending) {
      throw new BadRequestException('That code is not right, or it expired');
    }
    const record = this.pendings.get(pending.pendingId);
    this.forget(pending.pendingId);
    return { proof: await this.mint(email, accountId ?? record?.accountId) };
  }

  /**
   * The emailed link was followed - possibly in a different browser, on a
   * different device, with no session at all. Which is exactly why this takes
   * nothing but the token: the token *is* the proof of inbox access.
   *
   * The minted proof is parked on the pending record for {@link collect}, so
   * the tab that started the checkout picks it up on its next poll and moves
   * on by itself.
   */
  async confirmLink(token: string): Promise<{ email: string }> {
    this.sweep();
    const pendingId = this.byLinkToken.get(token);
    const record = pendingId ? this.pendings.get(pendingId) : undefined;
    if (!pendingId || !record || Date.now() > record.expiresAt) {
      throw new BadRequestException(
        'That link has expired. Start the payment again to get a new one.',
      );
    }
    record.proof = await this.mint(record.email, record.accountId);
    return { email: record.email };
  }

  /**
   * Has the link been followed yet? Answers the tab that started the flow, and
   * only that tab - `pendingId` was never emailed and never leaves the browser
   * that asked for it.
   */
  collect(pendingId: string): { verified: boolean; proof?: string } {
    this.sweep();
    const record = this.pendings.get(pendingId);
    if (!record?.proof) return { verified: false };
    const proof = record.proof;
    this.forget(pendingId);
    return { verified: true, proof };
  }

  /**
   * Is this checkout's email already settled? Either the caller is signed in
   * and the account has verified this very address - answered once, never
   * asked again - or they are carrying a proof minted moments ago.
   */
  async satisfies(
    email: string,
    proof: string | undefined,
    accountId: string | null,
  ): Promise<boolean> {
    const wanted = normalizeEmail(email);
    if (!wanted) return false;
    if (accountId) {
      const account = await this.users.findById(accountId);
      if (account?.emailVerified && normalizeEmail(account.email) === wanted) {
        return true;
      }
    }
    return this.holds(proof, wanted);
  }

  /** True when `proof` was issued for this very address and is still current. */
  async holds(proof: string | undefined, email: string): Promise<boolean> {
    if (!proof) return false;
    try {
      const claims = await this.jwt.verifyAsync<EmailProofClaims>(proof, {
        secret: this.secret,
      });
      return (
        claims.typ === 'email-proof' &&
        !!claims.email &&
        claims.email === normalizeEmail(email)
      );
    } catch {
      return false;
    }
  }

  /**
   * Sign the proof, and - when the answer came from someone signed in about
   * their own address - write it to their account too. This is an OTP to an
   * address they hold, which is exactly what the account's own email
   * verification asks for, so there is no reason to make them prove it twice.
   * From here on checkout stops asking.
   *
   * Only when the address matches the one on the account: a shopper is free to
   * have an order mailed to some other address, and proving that one says
   * nothing about the account's own.
   */
  private async mint(
    email: string,
    accountId?: string | null,
  ): Promise<string> {
    if (accountId) {
      try {
        const account = await this.users.findById(accountId);
        if (account && normalizeEmail(account.email) === email) {
          await this.users.setVerifiedEmail(accountId, email);
        }
      } catch (err: unknown) {
        // The proof still stands: this write is a convenience for next time,
        // not the thing the order in flight depends on.
        this.logger.warn(
          `Could not mark ${accountId}'s email verified: ${String(err)}`,
        );
      }
    }
    return this.jwt.signAsync(
      { typ: 'email-proof', email } satisfies EmailProofClaims,
      { secret: this.secret, expiresIn: PROOF_TTL },
    );
  }

  private findLivePending(
    email: string,
  ): { id: string; pending: Pending } | undefined {
    const now = Date.now();
    for (const [id, pending] of this.pendings) {
      if (pending.email === email && now < pending.expiresAt) {
        return { id, pending };
      }
    }
    return undefined;
  }

  private forget(pendingId: string): void {
    const record = this.pendings.get(pendingId);
    if (record) this.byLinkToken.delete(record.linkToken);
    this.pendings.delete(pendingId);
  }

  /** Drop expired records rather than growing a map for the process's life. */
  private sweep(): void {
    const now = Date.now();
    for (const [id, pending] of this.pendings) {
      if (now > pending.expiresAt) this.forget(id);
    }
  }
}
