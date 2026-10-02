import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import {
  Profile,
  Strategy,
  type VerifyCallback,
} from 'passport-google-oauth20';
import {
  UsersService,
  type GoogleProfileInput,
} from '../../users/users.service';

/**
 * What the callback receives for someone with no account here yet: nothing
 * has been created, and the callback turns it into a sign-up ticket.
 */
export interface PendingGoogleSignup {
  googleSignup: GoogleProfileInput;
}

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
    const input: GoogleProfileInput = {
      googleId: profile.id,
      email,
      name: profile.displayName || email.split('@')[0],
    };
    // Somebody new is not given an account here. They are asked to agree to
    // the policies first, back in the storefront, and the account is made
    // only once they do - see AuthService.completeGoogleSignup. An account
    // that already exists (by Google id, or by the same email) signs in, and
    // is linked, exactly as before.
    if (!(await this.users.findGoogleAccount(input))) {
      done(null, { googleSignup: input } satisfies PendingGoogleSignup);
      return;
    }
    const user = await this.users.upsertGoogleUser(input);
    done(null, user);
  }
}
