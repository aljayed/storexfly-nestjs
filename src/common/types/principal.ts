import type { Request } from 'express';

/** Authenticated seller/buyer, attached to `req.user` by the JWT strategy. */
export interface SellerPrincipal {
  kind: 'seller';
  id: string;
  email?: string;
  name: string;
  isAdmin: boolean;
}

/**
 * Authenticated admin-console staff member, attached by the admin JWT
 * strategy. Carries the shop scope and the verified-2FA claim.
 */
export interface AdminPrincipal {
  kind: 'admin';
  id: string;
  email: string;
  name: string;
  role: 'owner' | 'manager' | 'staff';
  shopId: string;
  twoFactorVerified: boolean;
}

/**
 * The platform operator (hoomri.com/platform-admin) — a single
 * env-configured identity, attached by the platform JWT strategy.
 */
export interface PlatformPrincipal {
  kind: 'platform';
  email: string;
}

/** A signed-in shopper, attached by the buyer JWT strategy. Leaves reviews. */
export interface BuyerPrincipal {
  kind: 'buyer';
  id: string;
  email: string;
  name: string;
}

export type Principal =
  | SellerPrincipal
  | AdminPrincipal
  | PlatformPrincipal
  | BuyerPrincipal;

export interface RequestWithPrincipal<P extends Principal = Principal>
  extends Request {
  user: P;
}
