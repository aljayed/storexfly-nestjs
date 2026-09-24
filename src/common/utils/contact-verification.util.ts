import type { UserRow } from '../../database/schema';
import type { ChangeAllowance } from './identity-change.util';

/**
 * What the console needs to render the "verify your contact details" step:
 * the addresses on file and whether each has been proved.
 */
export interface ContactStatus {
  email?: string;
  emailVerified: boolean;
  phone?: string;
  phoneVerified: boolean;
  /** True when the account may create a shop - both contacts verified. */
  complete: boolean;
  /** How many times this account may still move to a different verified
   *  number, and when the next one becomes possible - two per fortnight. */
  phoneChange: ChangeAllowance;
}

/**
 * A shop may be opened only by an account that has proved both ways of
 * reaching it: a verified email address *and* a verified phone number.
 *
 * For a while one was enough, to spare a seller whose SMS never arrived. But
 * a seller is someone the platform pays out to and answers for - orders,
 * payouts and disputes all need a person who can be reached on both - so
 * both are the floor. A phone number saved from a checkout does not count
 * until it is confirmed with a code.
 */
export function contactComplete(
  user: Pick<UserRow, 'email' | 'emailVerified' | 'phone' | 'phoneVerified'>,
): boolean {
  return (
    !!user.email && user.emailVerified && !!user.phone && user.phoneVerified
  );
}
