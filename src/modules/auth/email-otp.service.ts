import { Injectable, Logger } from '@nestjs/common';
import { randomInt, timingSafeEqual } from 'crypto';
import { MailService } from '../mail/mail.service';

interface PendingEntry {
  code: string;
  expiresAt: number;
  attempts: number;
  payload: unknown;
}

/**
 * Email OTP for blocking signup verification (seller + buyer). Like
 * {@link OtpService} (phone) this is an in-memory reference store — swap for
 * Redis in production so codes survive a restart and scale across instances.
 *
 * The pending signup payload travels alongside the code: nothing is written to
 * the database until the code is verified, so there's no such thing as an
 * unverified account row sitting around. `scope` namespaces the store per
 * flow (e.g. 'seller-register' vs 'buyer-signup') so the same email can't
 * collide across flows.
 */
@Injectable()
export class EmailOtpService {
  private readonly logger = new Logger(EmailOtpService.name);
  private readonly store = new Map<string, PendingEntry>();
  private readonly ttlMs = 10 * 60 * 1000;
  private readonly maxAttempts = 5;

  constructor(private readonly mail: MailService) {}

  async start<T>(
    scope: string,
    email: string,
    payload: T,
    mail?: { subject?: string; heading?: string; intro?: string },
  ): Promise<void> {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const key = this.key(scope, email);
    this.store.set(key, {
      code,
      expiresAt: Date.now() + this.ttlMs,
      attempts: 0,
      payload,
    });

    if (process.env.NODE_ENV !== 'production') {
      this.logger.debug(`OTP for ${key}: ${code}`);
    }

    const heading = mail?.heading ?? 'Verify your email';
    const intro = mail?.intro ?? 'Your Hoomri verification code is:';
    await this.mail.send({
      to: email,
      subject: mail?.subject ?? 'Your Hoomri verification code',
      text: textBody(code, intro),
      html: htmlBody(code, heading, intro),
    });
  }

  /** Returns the stored payload if the code matches and is unexpired; consumes the entry on success. */
  verify<T>(scope: string, email: string, code: string): T | null {
    const key = this.key(scope, email);
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    entry.attempts += 1;
    if (entry.attempts > this.maxAttempts) {
      this.store.delete(key);
      return null;
    }
    if (!constantTimeEquals(entry.code, code)) {
      return null;
    }
    this.store.delete(key);
    return entry.payload as T;
  }

  private key(scope: string, email: string): string {
    return `${scope}:${email.trim().toLowerCase()}`;
  }
}

function textBody(code: string, intro: string): string {
  return [
    `${intro} ${code}`,
    '',
    'This code expires in 10 minutes.',
    '',
    "If you didn't request this, you can safely ignore this email.",
  ].join('\n');
}

function htmlBody(code: string, heading: string, intro: string): string {
  return `
    <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;color:#1a1814">
      <h2 style="font-weight:800">${heading}</h2>
      <p>${intro}</p>
      <p style="margin:28px 0">
        <span style="font-size:32px;font-weight:800;letter-spacing:6px">${code}</span>
      </p>
      <p style="color:#87827a;font-size:13px">
        This code expires in 10 minutes. If you didn't request this, you can
        safely ignore this email.
      </p>
    </div>
  `;
}

/** Length-safe constant-time string compare (codes are short and same-charset). */
function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
