import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { randomInt, timingSafeEqual } from 'crypto';
import { SmsService, toMsisdn } from '../sms/sms.service';

interface OtpEntry {
  code: string;
  expiresAt: number;
  attempts: number;
}

/**
 * A number's send allowance for one day. Deliberately a separate record from
 * the code entry: a code lives five minutes but the allowance has to outlive it
 * all day, and holding both in one object is exactly what let the previous cap
 * reset itself every time a code expired.
 */
interface SendBudget {
  /** Dhaka calendar day this allowance belongs to. */
  day: number;
  sends: number;
  lastSentAt: number;
}

/** What {@link OtpService.issue} did. */
export interface OtpIssue {
  code: string;
  /** False when a live code was reused instead of a second SMS being paid for. */
  sent: boolean;
  /** Seconds until this number may ask for another code. */
  retryAfterSeconds: number;
  /** Codes this number has left today, after this call. */
  remainingToday: number;
}

/** The shape both phone-code endpoints answer with. */
export interface PhoneCodeSent {
  ok: true;
  /** How long the client should keep its resend control disabled. */
  retryAfterSeconds: number;
  remainingToday: number;
  /** Development only, when no SMS gateway is configured. */
  devCode?: string;
}

/**
 * Machine-readable marker for "this number is out of codes until tomorrow", so
 * a client can tell it apart from the per-IP throttle's identical 429 without
 * matching on prose. Travels in the envelope's `code`.
 */
export const OTP_DAILY_LIMIT = 'OTP_DAILY_LIMIT';

/** Bangladesh is UTC+6 all year, so "today" needs no timezone database. */
const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Which Dhaka day `ts` falls in, as a whole number of days since the epoch. */
function dayIndex(ts: number): number {
  return Math.floor((ts + DHAKA_OFFSET_MS) / DAY_MS);
}

/** Milliseconds from `ts` until midnight in Dhaka - when the allowance resets. */
function msUntilNextDay(ts: number): number {
  return (dayIndex(ts) + 1) * DAY_MS - DHAKA_OFFSET_MS - ts;
}

/**
 * Phone OTP issuing/verification, delivered over SMS by {@link SmsService}.
 * This is an in-memory reference store - swap it for Redis in production so
 * codes and allowances survive a restart and scale across instances. `scope`
 * namespaces the codes per flow, so one sent to confirm a number on an existing
 * account can never be replayed against checkout's guest verification.
 *
 * Two limits sit in front of the gateway, because route throttling is per IP
 * and does nothing against a script rotating addresses while every send costs
 * money:
 *
 * - a 60s quiet period, during which a "resend" returns the code already in the
 *   recipient's hand rather than paying for a duplicate;
 * - three codes per number per day, after which the number is refused until
 *   midnight Dhaka time.
 *
 * The daily allowance is keyed on the number alone, not on scope, so the two
 * flows share one budget and hopping between them cannot multiply it.
 */
@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);
  private readonly store = new Map<string, OtpEntry>();
  private readonly budgets = new Map<string, SendBudget>();
  private readonly ttlMs = 5 * 60 * 1000;
  private readonly maxAttempts = 5;
  private readonly resendCooldownMs = 60 * 1000;
  private readonly maxSendsPerDay = 3;
  private readonly isProduction = process.env.NODE_ENV === 'production';
  private lastSweep = 0;

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
   * Issues a code for `phone` within `scope`, texts it, and reports what
   * happened.
   *
   * A resend inside the quiet period keeps the code the recipient may already
   * be reading and skips the send, so repeated taps cost one SMS. Throws 429
   * once the number has spent the day's allowance, and throws rather than
   * reporting a send the gateway refused.
   */
  async issue(phone: string, scope = 'signin'): Promise<OtpIssue> {
    const now = Date.now();
    this.sweep(now);

    const msisdn = toMsisdn(phone);
    const key = this.key(scope, phone);
    const today = dayIndex(now);

    const prior = this.budgets.get(msisdn);
    const budget: SendBudget =
      prior && prior.day === today
        ? prior
        : { day: today, sends: 0, lastSentAt: 0 };

    const entry = this.store.get(key);
    const live = entry && now < entry.expiresAt ? entry : undefined;
    const remaining = Math.max(0, this.maxSendsPerDay - budget.sends);

    // Inside the quiet period the code they already hold is the answer, so say
    // how long is left and send nothing.
    const waited = now - budget.lastSentAt;
    if (live && waited < this.resendCooldownMs) {
      return {
        code: live.code,
        sent: false,
        retryAfterSeconds: Math.ceil((this.resendCooldownMs - waited) / 1000),
        remainingToday: remaining,
      };
    }

    if (budget.sends >= this.maxSendsPerDay) {
      // 429 rather than a quiet no-op: the caller has to be able to tell "your
      // code is already on its way" apart from "you get no more today".
      //
      // `code` carries that distinction, because the per-IP throttle in front
      // of these routes answers 429 too - and a client that reads the status
      // alone would tell someone behind a busy connection to come back
      // tomorrow over what is a one-minute wait. AllExceptionsFilter passes
      // `code` and `retryAfterSeconds` through and drops everything else, so
      // anything a client needs has to travel in one of those two.
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: 'Too Many Requests',
          code: OTP_DAILY_LIMIT,
          message:
            'You have used all of today’s verification codes for this number. Please try again tomorrow.',
          retryAfterSeconds: Math.ceil(msUntilNextDay(now) / 1000),
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // CSPRNG, 6 digits: Math.random is predictable enough to make a 4-digit
    // code guessable, which would let an attacker log in as any phone account.
    const code = live
      ? live.code
      : String(randomInt(0, 1_000_000)).padStart(6, '0');
    this.store.set(key, {
      code,
      expiresAt: live ? live.expiresAt : now + this.ttlMs,
      attempts: live ? live.attempts : 0,
    });
    this.budgets.set(msisdn, {
      day: today,
      sends: budget.sends + 1,
      lastSentAt: now,
    });

    if (!this.isProduction) {
      this.logger.debug(`OTP for ${key}: ${code}`);
    }

    try {
      await this.sms.send(phone, smsBody(code));
    } catch (err) {
      // Nothing reached the recipient, so it must not spend the day's
      // allowance - otherwise a gateway outage burns through it silently.
      if (prior && prior.day === today) this.budgets.set(msisdn, prior);
      else this.budgets.delete(msisdn);
      // Only drop a code this call minted: a failed *resend* must not
      // invalidate the one the recipient may already be holding.
      if (!live) this.store.delete(key);
      throw err;
    }

    return {
      code,
      sent: true,
      retryAfterSeconds: this.resendCooldownMs / 1000,
      remainingToday: this.maxSendsPerDay - (budget.sends + 1),
    };
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

  /**
   * Drops spent codes and yesterday's allowances. Both maps are keyed by
   * caller-supplied phone numbers, so without this they grow for the life of
   * the process. Amortised: at most once a minute, whoever asks first.
   */
  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [k, entry] of this.store) {
      if (now > entry.expiresAt) this.store.delete(k);
    }
    const today = dayIndex(now);
    for (const [k, budget] of this.budgets) {
      if (budget.day !== today) this.budgets.delete(k);
    }
  }

  /** Keyed on the dialable number, not on whatever shape the caller holds it
   *  in - otherwise `+8801…` and `01…` would each get their own allowance. */
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
