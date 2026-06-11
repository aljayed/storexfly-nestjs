import { Injectable, Logger } from '@nestjs/common';

interface OtpEntry {
  code: string;
  expiresAt: number;
  attempts: number;
}

/**
 * Phone OTP issuing/verification. This is an in-memory reference
 * implementation — swap the store for Redis and wire `dispatch()` to an SMS
 * provider (Twilio, etc.) in production. In non-production the code is logged so
 * the flow is testable without a gateway.
 */
@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);
  private readonly store = new Map<string, OtpEntry>();
  private readonly ttlMs = 5 * 60 * 1000;
  private readonly maxAttempts = 5;

  async issue(phone: string): Promise<void> {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    this.store.set(phone, {
      code,
      expiresAt: Date.now() + this.ttlMs,
      attempts: 0,
    });
    await this.dispatch(phone, code);
  }

  /** Returns true if the code matches and is unexpired; consumes it on success. */
  verify(phone: string, code: string): boolean {
    const entry = this.store.get(phone);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(phone);
      return false;
    }
    entry.attempts += 1;
    if (entry.attempts > this.maxAttempts) {
      this.store.delete(phone);
      return false;
    }
    if (entry.code !== code) {
      return false;
    }
    this.store.delete(phone);
    return true;
  }

  private async dispatch(phone: string, code: string): Promise<void> {
    if (process.env.NODE_ENV !== 'production') {
      this.logger.debug(`OTP for ${phone}: ${code}`);
    }
    // TODO: integrate SMS gateway (Twilio/Vonage) here.
    return Promise.resolve();
  }
}
