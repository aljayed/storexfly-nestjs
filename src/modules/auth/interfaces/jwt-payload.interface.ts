/** Claims carried by the seller-session JWT. */
export interface SellerJwtPayload {
  sub: string; // user id
  email?: string;
  name: string;
  isAdmin: boolean;
  typ: 'seller';
}

/** Claims carried by the buyer-session JWT (shopper reviews). */
export interface BuyerJwtPayload {
  sub: string; // buyer id
  email: string;
  name: string;
  typ: 'buyer';
}

/** Claims carried by the admin-console JWT (issued post-2FA). */
export interface AdminJwtPayload {
  sub: string; // admin user id
  email: string;
  name: string;
  role: 'owner' | 'manager' | 'staff';
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
