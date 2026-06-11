import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import {
  Profile,
  Strategy,
  type VerifyCallback,
} from 'passport-google-oauth20';
import { UsersService } from '../../users/users.service';

/**
 * "Continue with Google" for sellers/buyers. When OAuth env vars are absent the
 * strategy is constructed with placeholders so the app still boots; the
 * `GoogleOAuthGuard` short-circuits the routes with 503 in that case.
 */
@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(
    config: ConfigService,
    private readonly users: UsersService,
  ) {
    super({
      clientID: config.get<string>('google.clientId') || 'disabled',
      clientSecret: config.get<string>('google.clientSecret') || 'disabled',
      callbackURL: config.getOrThrow<string>('google.callbackUrl'),
      scope: ['email', 'profile'],
    });
  }

  async validate(
    _accessToken: string,
    _refreshToken: string,
    profile: Profile,
    done: VerifyCallback,
  ): Promise<void> {
    const email = profile.emails?.[0]?.value;
    if (!email) {
      done(new Error('Google account has no email'), undefined);
      return;
    }
    const user = await this.users.upsertGoogleUser({
      googleId: profile.id,
      email,
      name: profile.displayName || email.split('@')[0],
    });
    done(null, user);
  }
}
