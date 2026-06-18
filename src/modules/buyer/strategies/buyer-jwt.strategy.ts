import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { BuyerPrincipal } from '../../../common/types/principal';
import type { BuyerJwtPayload } from '../../auth/interfaces/jwt-payload.interface';
import { BuyerService } from '../buyer.service';

/**
 * Validates the buyer-session JWT and rehydrates the buyer from the DB so a
 * deleted account can't keep using a still-valid token. Shares the seller JWT
 * secret but only accepts tokens with `typ: 'buyer'`.
 */
@Injectable()
export class BuyerJwtStrategy extends PassportStrategy(Strategy, 'buyer-jwt') {
  constructor(
    config: ConfigService,
    private readonly buyers: BuyerService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('jwt.secret'),
    });
  }

  async validate(payload: BuyerJwtPayload): Promise<BuyerPrincipal> {
    if (payload.typ !== 'buyer') {
      throw new UnauthorizedException('Invalid token type');
    }
    const buyer = await this.buyers.findById(payload.sub);
    if (!buyer) {
      throw new UnauthorizedException('Account no longer exists');
    }
    return {
      kind: 'buyer',
      id: buyer.id,
      email: buyer.email,
      name: buyer.name,
    };
  }
}
