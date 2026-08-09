import {
  ForbiddenException,
  HttpStatus,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { authenticator } from 'otplib';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import {
  permissionsForRole,
  type AdminPermission,
} from '../../common/auth/admin-permissions';
import type { AdminPrincipal } from '../../common/types/principal';
import { shops, type AdminUserRow } from '../../database/schema';
import type { AdminRole } from '../../database/schema/enums';
import { handleize } from '../../common/utils/slug.util';
import { ShopsService } from '../shops/shops.service';
import { UsersService } from '../users/users.service';
import { AdminUsersService } from './admin-users.service';
import type { AdminLoginDto, AdminTwoFactorDto } from './dto/admin-login.dto';
import type { SetPasswordDto } from './dto/set-password.dto';
import { TokenService } from './token.service';

/** Matches the account side - see AuthService. */
const BCRYPT_ROUNDS = 12;

export interface AdminLoginResult {
  twoFactorRequired: boolean;
  ticket?: string;
  adminUser?: AdminUserView;
  token?: string;
}

export interface AdminAuthResult {
  adminUser: AdminUserView;
  token: string;
}

export interface AdminUserView {
  id: string;
  name: string;
  email: string;
  role: AdminUserRow['role'];
  /** Resolved capability strings for `role` - drives the console UI gating. */
  permissions: readonly AdminPermission[];
  shopId: string;
  twoFactorEnabled: boolean;
}

/**
 * Admin-console authentication - the stricter, 2FA-gated flow. Credentials are
 * scoped to a shop "workspace" (its handle); a verified TOTP step is required
 * before an admin-scoped JWT is issued.
 */
@Injectable()
export class AdminAuthService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly adminUsers: AdminUsersService,
    private readonly tokens: TokenService,
    private readonly shops: ShopsService,
    private readonly users: UsersService,
  ) {}

  /**
   * Stage 1 - verify the workspace + credentials, branch on 2FA.
   *
   * Authentication accepts either credential store, so a seller can use the
   * same email/password they use on Hoomri:
   *  - **Shop owner** - the password is checked against the platform `users`
   *    account; any shop the seller owns is a valid workspace (the admin token
   *    is scoped to that shop, not to the one their `admin_users` row happens to
   *    be pinned to). The console identity is provisioned on first use.
   *  - **Dedicated staff** - falls back to the `admin_users` password for a
   *    record explicitly scoped to this shop (e.g. a non-owner manager).
   */
  async login(dto: AdminLoginDto): Promise<AdminLoginResult> {
    const handle = handleize(dto.workspace);
    const shop = await this.db.query.shops.findFirst({
      where: eq(shops.handle, handle),
    });
    if (!shop) {
      throw new UnauthorizedException('Invalid workspace or credentials');
    }

    const seller = await this.users.findByEmail(dto.email);
    let admin = await this.adminUsers.findByEmail(dto.email);

    // Owner path: authenticate against the platform account, but only for a
    // workspace this seller actually owns.
    let authenticated = false;
    if (seller?.passwordHash && shop.ownerId === seller.id) {
      authenticated = await bcrypt.compare(dto.password, seller.passwordHash);
    }
    // Staff path: a dedicated admin_users record scoped to exactly this shop.
    if (!authenticated && admin?.shopId === shop.id) {
      authenticated = await bcrypt.compare(dto.password, admin.passwordHash);
    }
    if (!authenticated) {
      throw new UnauthorizedException('Invalid workspace or credentials');
    }

    // First time an owner opens the console: mint their admin identity. The
    // stored hash is a throwaway - owners always authenticate via `users` above.
    if (!admin) {
      const passwordHash = await bcrypt.hash(randomUUID(), 10);
      admin = await this.adminUsers.create({
        name: seller?.name ?? dto.email,
        email: dto.email.toLowerCase(),
        passwordHash,
        role: 'owner',
        shopId: shop.id,
        twoFactorEnabled: false,
      });
    }

    if (admin.twoFactorEnabled) {
      // Carry the resolved shop through the ticket so 2FA verification scopes
      // the issued token to the workspace the seller actually signed into.
      const ticket = await this.tokens.signTwoFactorTicket({
        sub: admin.id,
        shopId: shop.id,
      });
      return { twoFactorRequired: true, ticket };
    }

    // No second factor configured - issue the console token directly. A
    // seller signing into a workspace they own is 'owner' there even if their
    // staff row is pinned to another shop.
    await this.adminUsers.markLogin(admin.id);
    const role: AdminRole =
      shop.ownerId === seller?.id && admin.shopId !== shop.id
        ? 'owner'
        : admin.role;
    const token = await this.issueAdminToken(admin, shop.id, role);
    return {
      twoFactorRequired: false,
      adminUser: this.toView(admin, shop.id, role),
      token,
    };
  }

  /** Stage 2 - verify the TOTP code against the ticket, issue the console JWT. */
  async verifyTwoFactor(dto: AdminTwoFactorDto): Promise<AdminAuthResult> {
    const ticket = await this.tokens.verifyTwoFactorTicket(dto.ticket);
    const admin = await this.adminUsers.findById(ticket.sub);
    if (!admin || !admin.twoFactorSecret) {
      throw new UnauthorizedException('Invalid 2FA ticket');
    }
    const valid = authenticator.check(dto.code, admin.twoFactorSecret);
    if (!valid) {
      throw new UnauthorizedException('Invalid verification code');
    }
    await this.adminUsers.markLogin(admin.id);
    // Scope to the shop captured at stage 1, falling back to the admin's home
    // shop for older tickets that predate multi-shop. Mirror stage 1's role
    // resolution: signing into a workspace you own makes the session 'owner'
    // even when the staff row is pinned to a different shop.
    const shopId = ticket.shopId ?? admin.shopId;
    let role: AdminRole = admin.role;
    if (shopId !== admin.shopId) {
      const shop = await this.db.query.shops.findFirst({
        where: eq(shops.id, shopId),
      });
      const seller = await this.users.findByEmail(admin.email);
      role = shop && seller && shop.ownerId === seller.id ? 'owner' : role;
    }
    const token = await this.issueAdminToken(admin, shopId, role);
    return { adminUser: this.toView(admin, shopId, role), token };
  }

  /**
   * Elevate an already-authenticated seller session to an admin session, or
   * switch the active shop of an existing one. The seller JWT is proof of
   * identity, so no password/2FA is needed. An owner may have several shops;
   * `targetShopId` selects which one to open (defaulting to the most recent),
   * and the issued token is scoped to it - verified here to belong to the
   * seller so the token's shop claim can be trusted downstream.
   */
  async sellerSession(
    userId: string,
    email: string,
    name: string,
    targetShopId?: string,
  ): Promise<{ noShop: true } | AdminAuthResult> {
    const userShops = await this.shops.listForOwner(userId);
    if (!userShops.length) {
      return { noShop: true };
    }

    // Resolve the shop to open: the requested one (only if the seller owns it),
    // otherwise the most recently created shop.
    const activeShop =
      (targetShopId && userShops.find((s) => s.id === targetShopId)) ||
      userShops[0];
    if (targetShopId && activeShop.id !== targetShopId) {
      throw new ForbiddenException('You do not have access to this shop');
    }

    // `admin_users.email` is globally unique, so there is at most one admin
    // identity per email. Reuse it when present; only provision a record when
    // the seller has none. (Looking up by email alone, rather than email+shop,
    // prevents a duplicate-key crash for sellers who own more than one shop.)
    let admin = await this.adminUsers.findByEmail(email);
    if (!admin) {
      const passwordHash = await bcrypt.hash(randomUUID(), 10);
      admin = await this.adminUsers.create({
        name,
        email: email.toLowerCase(),
        passwordHash,
        role: 'owner',
        shopId: activeShop.id,
        twoFactorEnabled: false,
      });
    }

    await this.adminUsers.markLogin(admin.id);
    // Ownership of `activeShop` was just verified, so the session is 'owner'
    // regardless of the role their staff row carries for some other shop
    // (e.g. a seller who was also invited to a friend's shop as staff).
    const token = await this.issueAdminToken(admin, activeShop.id, 'owner');
    return { adminUser: this.toView(admin, activeShop.id, 'owner'), token };
  }

  /**
   * Which credential this console session actually signs in with.
   *
   * `login` accepts two stores, so "your password" means different rows for
   * different people: an owner types their Hoomri account password (`users`),
   * an invited staffer types the one on their `admin_users` record. The
   * profile page reads this to know which it is about to change - and whether
   * one exists at all, which it does not for an owner who has only ever used
   * Google.
   */
  private async credentialFor(principal: AdminPrincipal): Promise<
    | { kind: 'account'; userId: string; passwordHash: string | null }
    | { kind: 'console'; adminId: string; passwordHash: string }
  > {
    const admin = await this.adminUsers.findById(principal.id);
    if (!admin) {
      throw new UnauthorizedException('Admin account no longer exists');
    }
    const shop = await this.db.query.shops.findFirst({
      where: eq(shops.id, principal.shopId),
    });
    const seller = await this.users.findByEmail(admin.email);
    if (seller && shop && shop.ownerId === seller.id) {
      return {
        kind: 'account',
        userId: seller.id,
        passwordHash: seller.passwordHash,
      };
    }
    return {
      kind: 'console',
      adminId: admin.id,
      passwordHash: admin.passwordHash,
    };
  }

  /** What the console's profile page shows before anything is typed. */
  async passwordState(
    principal: AdminPrincipal,
  ): Promise<{ hasPassword: boolean; credential: 'account' | 'console' }> {
    const credential = await this.credentialFor(principal);
    return {
      hasPassword: !!credential.passwordHash,
      credential: credential.kind,
    };
  }

  /**
   * Set or change the password this console session signs in with, without
   * leaving the console (and without the account token, which a staffer who
   * signed in here directly never had).
   *
   * For an owner this writes the Hoomri account password - the same one the
   * account page edits, because it is the same credential `login` checks. An
   * account opened with Google has none yet, and the console session in hand
   * stands in for the current password exactly as it does on the account page;
   * Google sign-in is untouched either way.
   */
  async setPassword(
    principal: AdminPrincipal,
    dto: SetPasswordDto,
  ): Promise<{ hasPassword: boolean; credential: 'account' | 'console' }> {
    const credential = await this.credentialFor(principal);
    if (credential.passwordHash) {
      const ok =
        !!dto.currentPassword &&
        (await bcrypt.compare(dto.currentPassword, credential.passwordHash));
      if (!ok) {
        throw new UnauthorizedException({
          statusCode: HttpStatus.UNAUTHORIZED,
          error: 'CurrentPasswordInvalid',
          message: 'Your current password is not right.',
        });
      }
    }
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    if (credential.kind === 'account') {
      await this.users.updatePassword(credential.userId, passwordHash);
    } else {
      await this.adminUsers.updatePassword(credential.adminId, passwordHash);
    }
    return { hasPassword: true, credential: credential.kind };
  }

  private async issueAdminToken(
    admin: AdminUserRow,
    shopId: string = admin.shopId,
    role: AdminRole = admin.role,
  ): Promise<string> {
    return this.tokens.signAdminToken({
      sub: admin.id,
      email: admin.email,
      name: admin.name,
      role,
      shopId,
      twoFactorVerified: true,
    });
  }

  private toView(
    admin: AdminUserRow,
    shopId: string = admin.shopId,
    role: AdminRole = admin.role,
  ): AdminUserView {
    return {
      id: admin.id,
      name: admin.name,
      email: admin.email,
      role,
      permissions: permissionsForRole(role),
      shopId,
      twoFactorEnabled: admin.twoFactorEnabled,
    };
  }
}
