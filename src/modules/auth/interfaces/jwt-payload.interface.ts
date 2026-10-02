import type { SessionScope } from '../../../common/types/principal';
import type { AdminRole } from '../../../database/schema/enums';

/**
 * Claims carried by the account-session JWT - the single login for shopping and
 * selling. (`typ:'seller'` kept for backward compatibility with live tokens.)
 * `scp` narrows what the session may do; absent on tokens minted before scopes
 * existed, which are read as full `account` scope.
 */
export interface SellerJwtPayload {
  sub: string; // account (users) id
  email?: string;
  name: string;
  isAdmin: boolean;
  typ: 'seller';
  scp?: SessionScope;
}

/** Claims carried by the admin-console JWT (issued post-2FA). */
export interface AdminJwtPayload {
  sub: string; // admin user id
  email: string;
  name: string;
  role: AdminRole;
  shopId: string;
  twoFactorVerified: boolean;
  typ: 'admin';
}

/**
 * Claims carried by the platform-admin JWT (the hoomri.com/platform-admin
 * console). The operator is a single env-configured identity, so the subject
 * is a fixed sentinel rather than a database id.
 */
export interface PlatformJwtPayload {
  sub: 'platform-admin';
  email: string;
  typ: 'platform';
}

/** Short-lived ticket bridging the credentials and 2FA stages of admin login. */
export interface TwoFactorTicketPayload {
  sub: string; // admin user id
  shopId: string;
  stage: '2fa';
  typ: 'admin-2fa-ticket';
}

/**
 * A Google sign-in for someone with no account here yet. It carries what
 * Google vouched for, so the account can be made once the person agrees to
 * the policies back in the storefront - and nothing else: it is never a
 * session, and it cannot sign anyone in to an account that already exists.
 */
export interface GoogleSignupTicketPayload {
  gid: string; // Google account id
  email: string;
  name: string;
  typ: 'google-signup';
}
