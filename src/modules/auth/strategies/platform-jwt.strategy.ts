import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { PlatformPrincipal } from '../../../common/types/principal';
import type { PlatformJwtPayload } from '../interfaces/jwt-payload.interface';

/**
 * Validates the platform-admin JWT (its own secret, separate from the seller
 * and shop-admin tokens). The token's email must still match the configured
 * operator, so rotating PLATFORM_ADMIN_EMAIL invalidates old sessions.
 */
@Injectable()
export class PlatformJwtStrategy extends PassportStrategy(
  Strategy,
  'platform-jwt',
) {
  constructor(private readonly config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('platformAdmin.jwtSecret'),
    });
  }

  validate(payload: PlatformJwtPayload): PlatformPrincipal {
    const configuredEmail = this.config.getOrThrow<string>(
      'platformAdmin.email',
    );
    if (payload.typ !== 'platform' || payload.email !== configuredEmail) {
      throw new UnauthorizedException('Invalid token');
    }
    return { kind: 'platform', email: payload.email };
  }
}
