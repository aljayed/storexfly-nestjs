import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type {
  AdminJwtPayload,
  SellerJwtPayload,
} from '../auth/interfaces/jwt-payload.interface';
import { roleHasPermission } from '../../common/auth/admin-permissions';
import type { ChatActor } from './chat-actor';

/**
 * The chat module's ONLY tie into the host platform's auth. Accepts the
 * platform's existing session tokens - the account JWT for the customer side and
 * admin-console JWTs for the seller side - so chat needs no login of its own.
 *
 * Porting the module to another host means re-implementing just this class
 * (verify a raw bearer token, return a ChatActor); guards, gateway and
 * services only ever see ChatActor.
 */
@Injectable()
export class ChatTokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  /** Verify a raw bearer token into a chat participant, or throw 401. */
  async verify(token: string | undefined): Promise<ChatActor> {
    if (!token) {
      throw new UnauthorizedException('Missing chat credentials');
    }

    // Account session (typ 'seller', account-JWT secret) → customer side.
    try {
      const payload = await this.jwt.verifyAsync<SellerJwtPayload>(token, {
        secret: this.config.getOrThrow<string>('jwt.secret'),
      });
      if (payload.typ === 'seller') {
        return {
          role: 'customer',
          id: payload.sub,
          name: payload.name,
          email: payload.email ?? '',
        };
      }
    } catch {
      /* not an account token - try the admin secret */
    }

    // Admin-console session (typ 'admin', own secret) → seller side. The 2FA
    // claim is asserted like AdminJwtAuthGuard does, so a pre-2FA token can
    // never read a shop's inbox.
    try {
      const payload = await this.jwt.verifyAsync<AdminJwtPayload>(token, {
        secret: this.config.getOrThrow<string>('adminAuth.jwtSecret'),
      });
      if (
        payload.typ === 'admin' &&
        payload.twoFactorVerified === true &&
        payload.shopId &&
        // Limited staff tiers (items + reports only) have no inbox access.
        roleHasPermission(payload.role, 'chat.manage')
      ) {
        return {
          role: 'seller',
          id: payload.sub,
          shopId: payload.shopId,
          name: payload.name,
        };
      }
    } catch {
      /* fall through to the rejection below */
    }

    throw new UnauthorizedException('Invalid chat credentials');
  }
}
