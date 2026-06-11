import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { SellerPrincipal } from '../../../common/types/principal';
import { UsersService } from '../../users/users.service';
import type { SellerJwtPayload } from '../interfaces/jwt-payload.interface';

/**
 * Validates the seller-session JWT and rehydrates the principal from the DB so
 * a deleted/disabled account can't keep using a still-valid token.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    private readonly users: UsersService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('jwt.secret'),
    });
  }

  async validate(payload: SellerJwtPayload): Promise<SellerPrincipal> {
    if (payload.typ !== 'seller') {
      throw new UnauthorizedException('Invalid token type');
    }
    const user = await this.users.findById(payload.sub);
    if (!user) {
      throw new UnauthorizedException('Account no longer exists');
    }
    return {
      kind: 'seller',
      id: user.id,
      email: user.email ?? undefined,
      name: user.name,
      isAdmin: user.isAdmin,
    };
  }
}
