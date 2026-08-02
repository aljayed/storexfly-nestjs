import type { Request } from 'express';
import type { AdminRole } from '../../database/schema/enums';

/**
 * The authenticated account - the single human identity used for BOTH shopping
 * and selling (buyer and seller were unified into one `users` account). Attached
 * to `req.user` by the JWT strategy. `isAdmin` is the platform-admin flag; owning
 * a shop is what makes the account a seller. (Historically "seller"; kept for
 * blast radius - semantically it's the account.)
 */
export interface SellerPrincipal {
  kind: 'seller';
  id: string;
  email?: string;
  name: string;
  isAdmin: boolean;
}

/** Alias for the unified account principal - clearer in storefront/buyer code. */
export type AccountPrincipal = SellerPrincipal;

/**
 * Authenticated admin-console staff member, attached by the admin JWT
 * strategy. Carries the shop scope and the verified-2FA claim.
 */
export interface AdminPrincipal {
  kind: 'admin';
  id: string;
  email: string;
  name: string;
  role: AdminRole;
  shopId: string;
  twoFactorVerified: boolean;
}

/**
 * The platform operator (hoomri.com/platform-admin) - a single
 * env-configured identity, attached by the platform JWT strategy.
 */
export interface PlatformPrincipal {
  kind: 'platform';
  email: string;
}

export type Principal = SellerPrincipal | AdminPrincipal | PlatformPrincipal;

export interface RequestWithPrincipal<
  P extends Principal = Principal,
> extends Request {
  user: P;
}
