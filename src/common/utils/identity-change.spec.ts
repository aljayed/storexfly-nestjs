import {
  handleChangeAllowance,
  phoneChangeAllowance,
  recordPhoneChange,
} from './identity-change.util';

/**
 * The two rations that keep an account's public identity from being churned
 * through: one username change a month, two phone changes a fortnight.
 *
 * Both are enforced away from the screens that show them - the username on the
 * profile endpoint, the phone on the OTP confirm - so what matters here is
 * that the arithmetic they share agrees with what those screens promise, at
 * the edges nobody exercises by hand: the moment a window expires, a log that
 * refills one slot at a time, and data that cannot be read.
 */
describe('handleChangeAllowance', () => {
  const now = new Date('2026-03-20T12:00:00.000Z');

  it('lets an account that never claimed a username claim one', () => {
    expect(handleChangeAllowance(null, now).allowed).toBe(true);
  });

  it('refuses a second change inside the month, and says when', () => {
    const lastWeek = new Date('2026-03-13T12:00:00.000Z');
    const allowance = handleChangeAllowance(lastWeek, now);
    expect(allowance.allowed).toBe(false);
    // 30 days after the change, not 30 days from now.
    expect(allowance.nextAllowedAt).toBe('2026-04-12T12:00:00.000Z');
  });

  it('opens up again the instant the window closes', () => {
    const thirtyDaysAgo = new Date('2026-02-18T12:00:00.000Z');
    expect(handleChangeAllowance(thirtyDaysAgo, now).allowed).toBe(true);
  });

  it('treats an unreadable timestamp as no timestamp', () => {
    // Locking someone out over a value nothing can compare would be the worse
    // of the two failures.
    expect(handleChangeAllowance('not a date', now).allowed).toBe(true);
  });
});

describe('phoneChangeAllowance', () => {
  const now = new Date('2026-03-20T12:00:00.000Z');
  const iso = (day: string) => new Date(`2026-${day}T12:00:00.000Z`).toISOString();

  it('gives a fresh account both changes', () => {
    expect(phoneChangeAllowance(null, now).remaining).toBe(2);
  });

  it('counts one change against the fortnight', () => {
    const allowance = phoneChangeAllowance([iso('03-18')], now);
    expect(allowance.allowed).toBe(true);
    expect(allowance.remaining).toBe(1);
  });

  it('refuses the third, naming when the oldest one expires', () => {
    const allowance = phoneChangeAllowance([iso('03-18'), iso('03-15')], now);
    expect(allowance.allowed).toBe(false);
    expect(allowance.remaining).toBe(0);
    // The 15th's change frees its slot 14 days later - the 29th - even though
    // the 18th's is the one that filled the allowance last.
    expect(allowance.nextAllowedAt).toBe('2026-03-29T12:00:00.000Z');
  });

  it('refills one slot at a time as the window slides', () => {
    // The older of the two has aged out; only the recent one still counts.
    const allowance = phoneChangeAllowance([iso('03-18'), iso('03-01')], now);
    expect(allowance.allowed).toBe(true);
    expect(allowance.remaining).toBe(1);
  });

  it('ignores entries it cannot read rather than counting them', () => {
    expect(phoneChangeAllowance(['', 'yesterday'], now).remaining).toBe(2);
  });
});

describe('recordPhoneChange', () => {
  const now = new Date('2026-03-20T12:00:00.000Z');
  const iso = (day: string) => new Date(`2026-${day}T12:00:00.000Z`).toISOString();

  it('puts the new change at the front', () => {
    expect(recordPhoneChange([iso('03-18')], now)[0]).toBe(now.toISOString());
  });

  it('drops what can no longer refuse anything', () => {
    // The March 1st entry is already outside the window, so keeping it would
    // only grow the row for good.
    const log = recordPhoneChange([iso('03-18'), iso('03-01')], now);
    expect(log).toEqual([now.toISOString(), iso('03-18')]);
  });

  it('never grows past the allowance itself', () => {
    const log = recordPhoneChange([iso('03-19'), iso('03-18')], now);
    expect(log).toHaveLength(2);
  });
});
