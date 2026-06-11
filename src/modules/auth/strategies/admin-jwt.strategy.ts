import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { AdminPrincipal } from '../../../common/types/principal';
import { AdminUsersService } from '../admin-users.service';
import type { AdminJwtPayload } from '../interfaces/jwt-payload.interface';

/**
 * Validates the admin-console JWT (separate secret from the seller token) and
 * rehydrates the staff principal, preserving the verified-2FA claim.
 */
@Injectable()
export class AdminJwtStrategy extends PassportStrategy(Strategy, 'admin-jwt') {
  constructor(
    config: ConfigService,
    private readonly adminUsers: AdminUsersService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('adminAuth.jwtSecret'),
    });
  }

  async validate(payload: AdminJwtPayload): Promise<AdminPrincipal> {
    if (payload.typ !== 'admin') {
      throw new UnauthorizedException('Invalid token type');
    }
    const admin = await this.adminUsers.findById(payload.sub);
    if (!admin) {
      throw new UnauthorizedException('Admin account no longer exists');
    }
    return {
      kind: 'admin',
      id: admin.id,
      email: admin.email,
      name: admin.name,
      role: admin.role,
      // The active shop comes from the token, not the admin row: an owner can
      // manage several shops and switch between them, each switch minting a
      // fresh token whose shop ownership was verified at issue time. Fall back
      // to the admin's home shop for older tokens that predate multi-shop.
      shopId: payload.shopId ?? admin.shopId,
      twoFactorVerified: payload.twoFactorVerified === true,
    };
  }
}
