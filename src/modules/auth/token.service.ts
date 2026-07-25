import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import type {
  AdminJwtPayload,
  PlatformJwtPayload,
  SellerJwtPayload,
  TwoFactorTicketPayload,
} from './interfaces/jwt-payload.interface';

/**
 * Centralizes minting and verification of the three token kinds the platform
 * uses, each with its own secret and lifetime:
 *  - seller session JWT
 *  - admin-console JWT (post-2FA)
 *  - short-lived 2FA ticket (between admin login stages)
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async signSellerToken(
    payload: Omit<SellerJwtPayload, 'typ'>,
  ): Promise<string> {
    return this.jwt.signAsync(
      { ...payload, typ: 'seller' } satisfies SellerJwtPayload,
      {
        secret: this.config.getOrThrow<string>('jwt.secret'),
        expiresIn: this.config.getOrThrow<string>('jwt.expiresIn'),
      } as JwtSignOptions,
    );
  }

  async signAdminToken(payload: Omit<AdminJwtPayload, 'typ'>): Promise<string> {
    return this.jwt.signAsync(
      { ...payload, typ: 'admin' } satisfies AdminJwtPayload,
      {
        secret: this.config.getOrThrow<string>('adminAuth.jwtSecret'),
        expiresIn: this.config.getOrThrow<string>('adminAuth.jwtExpiresIn'),
      } as JwtSignOptions,
    );
  }

  async signPlatformToken(email: string): Promise<string> {
    return this.jwt.signAsync(
      {
        sub: 'platform-admin',
        email,
        typ: 'platform',
      } satisfies PlatformJwtPayload,
      {
        secret: this.config.getOrThrow<string>('platformAdmin.jwtSecret'),
        expiresIn: this.config.getOrThrow<string>('platformAdmin.jwtExpiresIn'),
      } as JwtSignOptions,
    );
  }

  async signTwoFactorTicket(
    payload: Omit<TwoFactorTicketPayload, 'typ' | 'stage'>,
  ): Promise<string> {
    return this.jwt.signAsync(
      {
        ...payload,
        stage: '2fa',
        typ: 'admin-2fa-ticket',
      } satisfies TwoFactorTicketPayload,
      {
        secret: this.config.getOrThrow<string>('adminAuth.ticketSecret'),
        expiresIn: this.config.getOrThrow<string>('adminAuth.ticketExpiresIn'),
      } as JwtSignOptions,
    );
  }

  async verifyTwoFactorTicket(token: string): Promise<TwoFactorTicketPayload> {
    try {
      const payload = await this.jwt.verifyAsync<TwoFactorTicketPayload>(
        token,
        {
          secret: this.config.getOrThrow<string>('adminAuth.ticketSecret'),
        },
      );
      if (payload.typ !== 'admin-2fa-ticket') {
        throw new Error('wrong token type');
      }
      return payload;
    } catch {
      throw new UnauthorizedException('Invalid or expired 2FA ticket');
    }
  }
}
