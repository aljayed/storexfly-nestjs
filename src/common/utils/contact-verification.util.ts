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
  /** True when the account may create a shop. */
  complete: boolean;
  /** How many times this account may still move to a different verified
   *  number, and when the next one becomes possible - two per fortnight. */
  phoneChange: ChangeAllowance;
}

/**
 * A shop may only be opened by an account holding one verified email *and*
 * one verified phone number. Both are the anti-spam floor: an unverifiable
 * account can't mint shops.
 */
export function contactComplete(
  user: Pick<UserRow, 'email' | 'emailVerified' | 'phone' | 'phoneVerified'>,
): boolean {
  return (
    !!user.email && user.emailVerified && !!user.phone && user.phoneVerified
  );
}
