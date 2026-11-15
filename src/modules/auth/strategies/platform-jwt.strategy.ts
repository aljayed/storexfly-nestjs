import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { PlatformPrincipal } from '../../../common/types/principal';
import { DRIZZLE } from '../../../database/database.constants';
import type { DrizzleDB } from '../../../database/drizzle.types';
import type { PlatformJwtPayload } from '../interfaces/jwt-payload.interface';
import { loadPlatformPrincipal } from '../platform-principal.loader';

/**
 * Validates the platform-console JWT (its own secret, separate from the seller
 * and shop-admin tokens) and re-reads the staff member behind it, so a
 * suspension, role change or forced sign-out applies on the very next request.
 */
@Injectable()
export class PlatformJwtStrategy extends PassportStrategy(
  Strategy,
  'platform-jwt',
) {
  constructor(
    config: ConfigService,
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('platformAdmin.jwtSecret'),
    });
  }

  async validate(payload: PlatformJwtPayload): Promise<PlatformPrincipal> {
    const principal = await loadPlatformPrincipal(this.db, payload);
    if (!principal) throw new UnauthorizedException('Session ended');
    return principal;
  }
}
