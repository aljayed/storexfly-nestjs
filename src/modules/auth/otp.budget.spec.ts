import { HttpException, HttpStatus } from '@nestjs/common';
import { OTP_DAILY_LIMIT, OtpService } from './otp.service';
import type { SmsService } from '../sms/sms.service';

/**
 * The send allowance decides how much money a stranger can make the platform
 * spend, so the reset semantics are worth pinning down: a code expiring must
 * not refill the day's budget, and a gateway failure must not drain it.
 */
describe('OtpService send allowance', () => {
  const PHONE = '+8801712345678';
  let sent: string[];
  let sms: SmsService;
  let otp: OtpService;
  let now: number;

  /** Fixed start: 2026-08-13 04:00 UTC = 10:00 in Dhaka, mid-morning. */
  const START = Date.UTC(2026, 7, 13, 4, 0, 0);

  beforeEach(() => {
    now = START;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    sent = [];
    sms = {
      enabled: true,
      send: jest.fn((phone: string) => {
        sent.push(phone);
        return Promise.resolve();
      }),
    } as unknown as SmsService;
    otp = new OtpService(sms);
  });

  afterEach(() => jest.restoreAllMocks());

  const advance = (ms: number) => {
    now += ms;
  };
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;

  it('sends the first code and starts the 60s cooldown', async () => {
    const issued = await otp.issue(PHONE, 'account-phone');
    expect(issued.sent).toBe(true);
    expect(issued.retryAfterSeconds).toBe(60);
    expect(issued.remainingToday).toBe(2);
    expect(sent).toHaveLength(1);
  });

  it('reuses the live code inside the cooldown without paying for a second SMS', async () => {
    const first = await otp.issue(PHONE, 'account-phone');
    advance(20_000);
    const second = await otp.issue(PHONE, 'account-phone');

    expect(second.sent).toBe(false);
    expect(second.code).toBe(first.code);
    expect(second.retryAfterSeconds).toBe(40);
    // Still only one message, and the reused attempt cost nothing.
    expect(sent).toHaveLength(1);
    expect(second.remainingToday).toBe(2);
  });

  it('allows three sends a day, then refuses with 429', async () => {
    await otp.issue(PHONE, 'account-phone');
    advance(2 * MINUTE);
    await otp.issue(PHONE, 'account-phone');
    advance(2 * MINUTE);
    const third = await otp.issue(PHONE, 'account-phone');
    expect(third.remainingToday).toBe(0);
    expect(sent).toHaveLength(3);

    advance(2 * MINUTE);
    await expect(otp.issue(PHONE, 'account-phone')).rejects.toBeInstanceOf(
      HttpException,
    );
    expect(sent).toHaveLength(3);
  });

  it('does not refill the allowance when the code expires', async () => {
    // The bug this guards: the counter used to live inside the code entry, so
    // every expiry handed the number a fresh budget five minutes later.
    await otp.issue(PHONE, 'account-phone');
    advance(2 * MINUTE);
    await otp.issue(PHONE, 'account-phone');
    advance(6 * MINUTE); // past the 5-minute code TTL
    await otp.issue(PHONE, 'account-phone');
    advance(6 * MINUTE);

    await expect(otp.issue(PHONE, 'account-phone')).rejects.toBeInstanceOf(
      HttpException,
    );
    expect(sent).toHaveLength(3);
  });

  it('shares one allowance across scopes, so hopping flows cannot multiply it', async () => {
    await otp.issue(PHONE, 'account-phone');
    advance(2 * MINUTE);
    await otp.issue(PHONE, 'checkout-phone');
    advance(2 * MINUTE);
    await otp.issue(PHONE, 'account-phone');
    advance(2 * MINUTE);

    await expect(otp.issue(PHONE, 'checkout-phone')).rejects.toBeInstanceOf(
      HttpException,
    );
    expect(sent).toHaveLength(3);
  });

  it('counts one allowance per number however the caller spells it', async () => {
    await otp.issue('+8801712345678', 'checkout-phone');
    advance(2 * MINUTE);
    await otp.issue('01712345678', 'checkout-phone');
    advance(2 * MINUTE);
    await otp.issue('1712345678', 'checkout-phone');
    advance(2 * MINUTE);

    await expect(
      otp.issue('8801712345678', 'checkout-phone'),
    ).rejects.toBeInstanceOf(HttpException);
    expect(sent).toHaveLength(3);
  });

  it('resets at midnight Dhaka, not 24h after the first send', async () => {
    await otp.issue(PHONE, 'account-phone');
    advance(2 * MINUTE);
    await otp.issue(PHONE, 'account-phone');
    advance(2 * MINUTE);
    await otp.issue(PHONE, 'account-phone');

    // 22:00 Dhaka the same day - still spent.
    advance(12 * HOUR);
    await expect(otp.issue(PHONE, 'account-phone')).rejects.toBeInstanceOf(
      HttpException,
    );

    // 02:00 Dhaka the next day - a new allowance, well under 24h elapsed.
    advance(4 * HOUR);
    const fresh = await otp.issue(PHONE, 'account-phone');
    expect(fresh.sent).toBe(true);
    expect(fresh.remainingToday).toBe(2);
    expect(sent).toHaveLength(4);
  });

  it('does not spend the allowance when the gateway refuses', async () => {
    (sms.send as jest.Mock).mockRejectedValueOnce(new Error('gateway down'));
    await expect(otp.issue(PHONE, 'account-phone')).rejects.toThrow(
      'gateway down',
    );

    // The failed attempt cost nothing, so all three are still available.
    const retry = await otp.issue(PHONE, 'account-phone');
    expect(retry.sent).toBe(true);
    expect(retry.remainingToday).toBe(2);
  });

  it('marks the refusal with a code the per-IP throttle does not use', async () => {
    // AllExceptionsFilter forwards only `code` and `retryAfterSeconds` from an
    // exception body. Both matter here: the throttle in front of these routes
    // answers 429 as well, so a client reading the status alone cannot tell a
    // one-minute wait from "come back tomorrow".
    await otp.issue(PHONE, 'account-phone');
    advance(2 * MINUTE);
    await otp.issue(PHONE, 'account-phone');
    advance(2 * MINUTE);
    await otp.issue(PHONE, 'account-phone');
    advance(2 * MINUTE);

    const err = await otp
      .issue(PHONE, 'account-phone')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    const thrown = err as HttpException;
    expect(thrown.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);

    const body = thrown.getResponse() as {
      code?: string;
      retryAfterSeconds?: number;
    };
    expect(body.code).toBe(OTP_DAILY_LIMIT);
    // 10:06 Dhaka -> just under 14 hours to midnight, when it resets.
    expect(body.retryAfterSeconds).toBeGreaterThan(13 * 3600);
    expect(body.retryAfterSeconds).toBeLessThanOrEqual(14 * 3600);
  });

  it('verifies a reused code, and refuses it once consumed', async () => {
    const first = await otp.issue(PHONE, 'account-phone');
    advance(20_000);
    await otp.issue(PHONE, 'account-phone'); // cooldown: same code

    expect(otp.verify(PHONE, first.code, 'account-phone')).toBe(true);
    expect(otp.verify(PHONE, first.code, 'account-phone')).toBe(false);
  });
});
