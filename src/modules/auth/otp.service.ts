import { Injectable, Logger } from '@nestjs/common';
import { randomInt, timingSafeEqual } from 'crypto';
import { SmsService, toMsisdn } from '../sms/sms.service';

interface OtpEntry {
  code: string;
  expiresAt: number;
  attempts: number;
  /** When the code was last put on the wire - drives the resend cooldown. */
  lastSentAt: number;
  /** Sends in the current hour, and when that hour started. */
  sends: number;
  windowStart: number;
}

/**
 * Phone OTP issuing/verification, delivered over SMS by {@link SmsService}.
 * This is an in-memory reference store - swap it for Redis in production so
 * codes survive a restart and scale across instances. `scope` namespaces the
 * store per flow, so a code sent to confirm a number on an existing account can
 * never be replayed against checkout's guest verification.
 */
@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);
  private readonly store = new Map<string, OtpEntry>();
  private readonly ttlMs = 5 * 60 * 1000;
  private readonly maxAttempts = 5;
  /** Quiet period between two texts to the same number in one flow. */
  private readonly resendCooldownMs = 60 * 1000;
  /** Ceiling per number per hour. Route throttling is per IP, which does
   *  nothing against a script rotating addresses - and every send costs money,
   *  so the number itself needs its own budget. */
  private readonly maxSendsPerHour = 5;
  private readonly sendWindowMs = 60 * 60 * 1000;

  constructor(private readonly sms: SmsService) {}

  /**
   * True once codes really reach the recipient. While it is false callers may
   * show the issued code to the user (dummy verification) - it flips on its own
   * the moment SMS_* is configured, so codes stop leaking into responses.
   */
  get smsEnabled(): boolean {
    return this.sms.enabled;
  }

  /**
   * Issues a code for `phone` within `scope`, texts it, and returns it.
   *
   * A resend inside the cooldown keeps the code the recipient may already be
   * reading and skips the send - so repeated taps cost one SMS, and the code on
   * their screen still works. Throws if the gateway refuses the message rather
   * than reporting a send that never happened.
   */
  async issue(phone: string, scope = 'signin'): Promise<string> {
    const key = this.key(scope, phone);
    const now = Date.now();
    const live = this.store.get(key);
    const reuse = !!live && now < live.expiresAt;

    if (reuse) {
      const waited = now - live.lastSentAt;
      const inWindow = now - live.windowStart < this.sendWindowMs;
      // Still their code either way; we just don't pay to send it again.
      if (waited < this.resendCooldownMs) return live.code;
      if (inWindow && live.sends >= this.maxSendsPerHour) return live.code;
    }

    // CSPRNG, 6 digits: Math.random is predictable enough to make a 4-digit
    // code guessable, which would let an attacker log in as any phone account.
    const code = reuse
      ? live.code
      : String(randomInt(0, 1_000_000)).padStart(6, '0');
    const windowOpen = reuse && now - live.windowStart < this.sendWindowMs;
    this.store.set(key, {
      code,
      expiresAt: reuse ? live.expiresAt : now + this.ttlMs,
      attempts: reuse ? live.attempts : 0,
      lastSentAt: now,
      sends: windowOpen ? live.sends + 1 : 1,
      windowStart: windowOpen ? live.windowStart : now,
    });

    if (process.env.NODE_ENV !== 'production') {
      this.logger.debug(`OTP for ${key}: ${code}`);
    }

    try {
      await this.sms.send(phone, smsBody(code));
    } catch (err) {
      // Undelivered and unusable: drop it so the next attempt starts clean
      // instead of inheriting this one's spent send budget.
      this.store.delete(key);
      throw err;
    }
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

  /** Keyed on the dialable number, not on whatever shape the caller holds it
   *  in - otherwise `+8801…` and `01…` would each get their own send budget. */
  private key(scope: string, phone: string): string {
    return `${scope}:${toMsisdn(phone)}`;
  }
}

/**
 * The sender ID is a numeric shortcode, so the body is the only thing telling
 * the recipient who is asking - hence the brand in the first clause.
 *
 * Keep every character in this string ASCII, and mind the apostrophe in
 * particular: a typographic one (’) falls outside the GSM 7-bit alphabet, which
 * would push the message to UCS-2, drop the per-segment limit from 160 to 70,
 * and quietly bill two segments for every OTP the platform sends.
 */
function smsBody(code: string): string {
  return `Your Hoomri verification code is ${code}. It expires in 5 minutes. Don't share this code with anyone.`;
}

/** Length-safe constant-time string compare (codes are short and same-charset). */
function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
