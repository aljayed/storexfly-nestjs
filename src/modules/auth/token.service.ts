import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import type { SessionScope } from '../../common/types/principal';
import type {
  AdminJwtPayload,
  GoogleSignupTicketPayload,
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
 *  - short-lived Google sign-up ticket (between Google and the buyer's
 *    agreement to the policies)
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Mints the account session token. `scp` says how much the session may do -
   * see {@link SessionScope}; it is always written so a session can never be
   * silently upgraded by an omitted claim.
   */
  async signSellerToken(
    payload: Omit<SellerJwtPayload, 'typ' | 'scp'>,
    scope: SessionScope = 'account',
  ): Promise<string> {
    return this.jwt.signAsync(
      { ...payload, typ: 'seller', scp: scope } satisfies SellerJwtPayload,
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

  /**
   * Signed with its own key, derived from the session secret: the session
   * strategy already refuses any `typ` but `seller`, and a key no session
   * verifier holds means nothing that checks a session signature can be
   * talked into reading one of these either.
   */
  private googleSignupSecret(): string {
    return `${this.config.getOrThrow<string>('jwt.secret')}:google-signup`;
  }

  async signGoogleSignupTicket(
    payload: Omit<GoogleSignupTicketPayload, 'typ'>,
  ): Promise<string> {
    return this.jwt.signAsync(
      { ...payload, typ: 'google-signup' } satisfies GoogleSignupTicketPayload,
      // Long enough to read the policies; short enough that a link left in a
      // browser's history is worth nothing by the time anyone finds it.
      { secret: this.googleSignupSecret(), expiresIn: '15m' } as JwtSignOptions,
    );
  }

  async verifyGoogleSignupTicket(
    token: string,
  ): Promise<GoogleSignupTicketPayload> {
    try {
      const payload = await this.jwt.verifyAsync<GoogleSignupTicketPayload>(
        token,
        { secret: this.googleSignupSecret() },
      );
      if (payload.typ !== 'google-signup' || !payload.gid || !payload.email) {
        throw new Error('wrong token type');
      }
      return payload;
    } catch {
      // 400, not 401: a 401 tells the storefront its own session has lapsed,
      // and someone already signed in who tries a new Google account must not
      // be signed out because that sign-up took too long.
      throw new BadRequestException({
        code: 'GOOGLE_SIGNUP_EXPIRED',
        message: 'This sign-up has expired. Please continue with Google again.',
      });
    }
  }
}
