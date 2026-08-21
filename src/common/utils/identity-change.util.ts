/**
 * How often an account may change the two things other people identify it by.
 *
 * A username and a phone number are both addressable: people message "@rafiq",
 * couriers ring the number on the parcel, and a stolen session that can rename
 * an account freely can walk away with the identity behind it. So both are
 * rationed - not to make them hard to correct, but to make churning through
 * them impossible.
 *
 * The rules live here, apart from either service, because two sides enforce
 * them: the username on the profile endpoints and the phone number on the OTP
 * confirm. Neither may drift from what the screens promise.
 */

/** A username may be changed once in this window - the first claim included. */
export const HANDLE_CHANGE_WINDOW_DAYS = 30;
/** Two phone changes per fortnight, counted on a rolling window. */
export const PHONE_CHANGE_WINDOW_DAYS = 14;
export const PHONE_CHANGES_PER_WINDOW = 2;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a change is allowed right now, and when the next one becomes
 * possible. Shipped to the client as-is: a screen that can say "you can change
 * this again on 12 September" never has to make the person find out by being
 * refused.
 */
export interface ChangeAllowance {
  allowed: boolean;
  /** ISO timestamp of the next permitted change, null while one is allowed. */
  nextAllowedAt: string | null;
  /** Changes still available inside the current window. */
  remaining: number;
}

const allowed = (remaining: number): ChangeAllowance => ({
  allowed: true,
  nextAllowedAt: null,
  remaining,
});

/**
 * The username allowance. `changedAt` is when it was last set - null on an
 * account that has never claimed one, which is always free to.
 */
export function handleChangeAllowance(
  changedAt: Date | string | null | undefined,
  now: Date = new Date(),
): ChangeAllowance {
  if (!changedAt) return allowed(1);
  const last = new Date(changedAt).getTime();
  if (!Number.isFinite(last)) return allowed(1);
  const next = last + HANDLE_CHANGE_WINDOW_DAYS * DAY_MS;
  return next <= now.getTime()
    ? allowed(1)
    : { allowed: false, nextAllowedAt: new Date(next).toISOString(), remaining: 0 };
}

/**
 * The phone allowance, from the log of past changes. Only timestamps inside
 * the window count, so the ration refills gradually rather than all at once -
 * and `nextAllowedAt` is when the oldest of them falls out of it.
 */
export function phoneChangeAllowance(
  log: readonly string[] | null | undefined,
  now: Date = new Date(),
): ChangeAllowance {
  const recent = withinWindow(log, now);
  const remaining = Math.max(0, PHONE_CHANGES_PER_WINDOW - recent.length);
  if (remaining > 0) return allowed(remaining);
  // Spent. The oldest change in the window is the one whose expiry frees a slot.
  const oldest = recent[recent.length - 1];
  return {
    allowed: false,
    nextAllowedAt: new Date(
      oldest + PHONE_CHANGE_WINDOW_DAYS * DAY_MS,
    ).toISOString(),
    remaining: 0,
  };
}

/**
 * The log with this change added, newest first, trimmed to the entries that
 * can still matter. Anything older than the window can never refuse a change
 * again, so keeping it would only grow the row.
 */
export function recordPhoneChange(
  log: readonly string[] | null | undefined,
  now: Date = new Date(),
): string[] {
  const kept = withinWindow(log, now).map((ts) => new Date(ts).toISOString());
  return [now.toISOString(), ...kept].slice(0, PHONE_CHANGES_PER_WINDOW);
}

/**
 * "12 September 2026" - the day a refusal names, so the message says when to
 * come back rather than how many days are left. Dhaka time, because that is
 * the calendar the person reading it is on.
 */
export function formatDay(iso: string | null): string {
  if (!iso) return 'soon';
  return new Date(iso).toLocaleDateString('en-GB', {
    timeZone: 'Asia/Dhaka',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/** Timestamps from the log that are still inside the window, newest first. */
function withinWindow(
  log: readonly string[] | null | undefined,
  now: Date,
): number[] {
  const floor = now.getTime() - PHONE_CHANGE_WINDOW_DAYS * DAY_MS;
  return (log ?? [])
    .map((iso) => new Date(iso).getTime())
    // A malformed entry is dropped rather than trusted: it cannot be compared,
    // and counting it would lock the account out on unreadable data.
    .filter((ts) => Number.isFinite(ts) && ts > floor)
    .sort((a, b) => b - a);
}
