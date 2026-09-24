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
  /** True when the account may create a shop - one verified contact does it. */
  complete: boolean;
  /** How many times this account may still move to a different verified
   *  number, and when the next one becomes possible - two per fortnight. */
  phoneChange: ChangeAllowance;
}

/**
 * A shop may be opened by an account that has proved one way of reaching it -
 * a verified email address or a verified phone number.
 *
 * It used to demand both. That is a better anti-spam floor, and it is also
 * two codes to receive before a seller has seen anything of the product; a
 * seller whose SMS never arrives cannot open a shop at all, however much
 * else they have proved. One proven contact is the floor now, and the other
 * is offered rather than required - the account still cannot be a ghost, and
 * the wizard still asks for a public contact and a pickup number for the
 * shop itself.
 */
export function contactComplete(
  user: Pick<UserRow, 'email' | 'emailVerified' | 'phone' | 'phoneVerified'>,
): boolean {
  return (
    (!!user.email && user.emailVerified) || (!!user.phone && user.phoneVerified)
  );
}
