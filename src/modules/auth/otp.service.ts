import { Injectable, Logger } from '@nestjs/common';
import { randomInt, timingSafeEqual } from 'crypto';

interface OtpEntry {
  code: string;
  expiresAt: number;
  attempts: number;
}

/**
 * Phone OTP issuing/verification. This is an in-memory reference
 * implementation - swap the store for Redis and wire `dispatch()` to an SMS
 * provider (Twilio, etc.) in production. In non-production the code is logged so
 * the flow is testable without a gateway.
 */
@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);
  private readonly store = new Map<string, OtpEntry>();
  private readonly ttlMs = 5 * 60 * 1000;
  private readonly maxAttempts = 5;

  /**
   * False until `dispatch()` really talks to an SMS gateway. While it is
   * false callers may show the issued code to the user (dummy verification) -
   * flip it to true the moment SMS goes live so codes stop leaking into
   * responses.
   */
  readonly smsEnabled = false;

  /**
   * Issues a code for `phone` within `scope` and returns it. Scopes keep
   * flows apart, so a code sent to confirm a number on an existing account
   * can never be replayed against the passwordless sign-in endpoint.
   */
  async issue(phone: string, scope = 'signin'): Promise<string> {
    // CSPRNG, 6 digits: Math.random is predictable enough to make a 4-digit
    // code guessable, which would let an attacker log in as any phone account.
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    this.store.set(this.key(scope, phone), {
      code,
      expiresAt: Date.now() + this.ttlMs,
      attempts: 0,
    });
    await this.dispatch(phone, code);
    return code;
  }

  /** Returns true if the code matches and is unexpired; consumes it on success. */
  verify(phone: string, code: string, scope = 'signin'): boolean {
    const key = this.key(scope, phone);
    const entry = this.store.get(key);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return false;
    }
    entry.attempts += 1;
    if (entry.attempts > this.maxAttempts) {
      this.store.delete(key);
      return false;
    }
    if (!constantTimeEquals(entry.code, code)) {
      return false;
    }
    this.store.delete(key);
    return true;
  }

  private key(scope: string, phone: string): string {
    return `${scope}:${phone.trim()}`;
  }

  private async dispatch(phone: string, code: string): Promise<void> {
    if (process.env.NODE_ENV !== 'production') {
      this.logger.debug(`OTP for ${phone}: ${code}`);
    }
    // TODO: integrate SMS gateway (Twilio/Vonage) here, then set smsEnabled.
    return Promise.resolve();
  }
}

/** Length-safe constant-time string compare (codes are short and same-charset). */
function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
