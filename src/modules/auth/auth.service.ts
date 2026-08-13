import {
  ConflictException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import {
  contactComplete,
  type ContactStatus,
} from '../../common/utils/contact-verification.util';
import type { UserRow } from '../../database/schema';
import { BlockedWordsService } from '../blocked-words/blocked-words.service';
import { UserResponse } from '../users/dto/user.response';
import { UsersService } from '../users/users.service';
import { EmailOtpService } from './email-otp.service';
import type { LoginDto } from './dto/login.dto';
import type { RegisterDto } from './dto/register.dto';
import type { SetPasswordDto } from './dto/set-password.dto';
import { OtpService, type PhoneCodeSent } from './otp.service';
import { SessionScopeService } from './session-scope.service';
import { TokenService } from './token.service';

const BCRYPT_ROUNDS = 12;
/** OTP scopes for proving contact details on an *existing* account. */
const VERIFY_PHONE_SCOPE = 'account-phone';
const VERIFY_EMAIL_SCOPE = 'account-email';

export interface AuthResult {
  user: UserResponse;
  token: string;
}

/**
 * Seller/buyer authentication: email register/login and the Google upsert.
 * Issues seller-scoped JWTs via {@link TokenService}.
 *
 * Signing up proves nothing - no code is emailed or texted, and the account
 * starts with both contact details unverified, which {@link
 * SessionScopeService} reads as a `storefront` session. Proving an email and a
 * phone number is asked for once, in the create-shop wizard, and that is what
 * lifts the session to a full `account` one.
 */
@Injectable()
export class AuthService {
  private readonly isProduction = process.env.NODE_ENV === 'production';

  constructor(
    private readonly users: UsersService,
    private readonly tokens: TokenService,
    private readonly otp: OtpService,
    private readonly emailOtp: EmailOtpService,
    private readonly blockedWords: BlockedWordsService,
    private readonly sessionScope: SessionScopeService,
  ) {}

  /** Creates the account and signs it straight in - no code to type first. */
  async register(dto: RegisterDto): Promise<AuthResult> {
    const existing = await this.users.findByEmail(dto.email);
    if (existing) {
      throw new ConflictException('An account with this email already exists');
    }
    await this.blockedWords.assertClean(dto.name);
    const user = await this.users.create({
      name: dto.name,
      email: dto.email,
      passwordHash: await bcrypt.hash(dto.password, BCRYPT_ROUNDS),
      via: 'email',
      // Typing an address doesn't prove it. The create-shop wizard asks for
      // the proof, for both the email and a phone number, in one place.
      emailVerified: false,
    });
    return this.toAuthResult(user);
  }

  /**
   * The sign-in form offers to create the account on the spot when the email
   * is unknown, so this has to answer *why* it refused. Saying "no account
   * uses this email" does confirm which addresses are registered - but
   * `register` already answers that with its 409, so the pair of requests
   * reveals nothing a single one didn't. A wrong password stays deliberately
   * vague: that is the answer worth protecting.
   */
  async login(dto: LoginDto): Promise<AuthResult> {
    const user = await this.users.findByEmail(dto.email);
    if (!user) {
      throw new UnauthorizedException({
        statusCode: HttpStatus.UNAUTHORIZED,
        error: 'AccountNotFound',
        message: 'No account uses this email address.',
      });
    }
    if (!user.passwordHash) {
      // An account *does* exist - it was made through Google (or the retired
      // phone login), so offering to create one would only 409, and there is
      // no password to reset either: PasswordResetService skips rows with no
      // hash. Point at the door that actually opens.
      throw new UnauthorizedException({
        statusCode: HttpStatus.UNAUTHORIZED,
        error: 'PasswordNotSet',
        message:
          'This account has no password - use Continue with Google to sign in.',
      });
    }
    const ok = await bcrypt.compare(dto.password, user.passwordHash);
    if (!ok) {
      throw new UnauthorizedException('Invalid email or password');
    }
    return this.toAuthResult(user);
  }

  /** Completes the Google flow: the user was already upserted by the strategy. */
  async issueForUser(user: UserRow): Promise<AuthResult> {
    return this.toAuthResult(user);
  }

  // ── Contact verification (prerequisite for creating a shop) ────
  //
  // A shop may only be opened by an account with one verified email *and*
  // one verified phone number, both unique to that account. Signing up proves
  // neither, so both are proved here - the only place in the product that ever
  // asks for a code. Codes go out over SMS; only a development environment with
  // no gateway configured hands one back in the response for the wizard to
  // show, and production never does regardless.

  async contactStatus(userId: string): Promise<ContactStatus> {
    const user = await this.requireUser(userId);
    return {
      email: user.email ?? undefined,
      emailVerified: user.emailVerified,
      phone: user.phone ?? undefined,
      phoneVerified: user.phoneVerified,
      complete: contactComplete(user),
    };
  }

  /** Sends a code to a number the signed-in account wants to prove. */
  async startPhoneVerification(
    userId: string,
    phone: string,
  ): Promise<PhoneCodeSent> {
    const user = await this.requireUser(userId);
    const owner = await this.users.findByVerifiedPhone(phone);
    if (owner && owner.id !== user.id) {
      throw new ConflictException(
        'This phone number is already verified on another account',
      );
    }
    const issued = await this.otp.issue(phone, VERIFY_PHONE_SCOPE);
    return {
      ok: true,
      retryAfterSeconds: issued.retryAfterSeconds,
      remainingToday: issued.remainingToday,
      // Never in production, even if SMS is misconfigured there: handing out
      // the code would make the whole check ornamental.
      ...(this.otp.smsEnabled || this.isProduction
        ? {}
        : { devCode: issued.code }),
    };
  }

  /** Confirms the code and stores the number as verified on the account. */
  async confirmPhoneVerification(
    userId: string,
    phone: string,
    code: string,
  ): Promise<UserResponse> {
    const user = await this.requireUser(userId);
    if (!this.otp.verify(phone, code, VERIFY_PHONE_SCOPE)) {
      throw new UnauthorizedException('Invalid or expired code');
    }
    // Re-check on confirm: another account could have verified the same
    // number between the two calls.
    const owner = await this.users.findByVerifiedPhone(phone);
    if (owner && owner.id !== user.id) {
      throw new ConflictException(
        'This phone number is already verified on another account',
      );
    }
    return UserResponse.fromRow(
      await this.users.setVerifiedPhone(user.id, phone),
    );
  }

  /**
   * Emails a code to an address the signed-in account wants to prove. Used by
   * phone-first accounts (which have no email yet) and by anyone changing the
   * address their shop is opened under.
   */
  async startEmailVerification(
    userId: string,
    email: string,
  ): Promise<{ ok: true }> {
    const user = await this.requireUser(userId);
    const existing = await this.users.findByEmail(email);
    if (existing && existing.id !== user.id) {
      throw new ConflictException('An account with this email already exists');
    }
    await this.emailOtp.start<{ userId: string; email: string }>(
      VERIFY_EMAIL_SCOPE,
      email,
      { userId: user.id, email },
      {
        subject: 'Verify your email',
        heading: 'Verify your email',
        intro: 'Use this code to confirm your email on Hoomri:',
      },
    );
    return { ok: true };
  }

  async confirmEmailVerification(
    userId: string,
    email: string,
    code: string,
  ): Promise<UserResponse> {
    const user = await this.requireUser(userId);
    const pending = this.emailOtp.verify<{ userId: string; email: string }>(
      VERIFY_EMAIL_SCOPE,
      email,
      code,
    );
    // The code is bound to the account that requested it - a code emailed to
    // one seller can't be pasted into another's session.
    if (!pending || pending.userId !== user.id) {
      throw new UnauthorizedException('Invalid or expired code');
    }
    const existing = await this.users.findByEmail(pending.email);
    if (existing && existing.id !== user.id) {
      throw new ConflictException('An account with this email already exists');
    }
    return UserResponse.fromRow(
      await this.users.setVerifiedEmail(user.id, pending.email),
    );
  }

  private async requireUser(userId: string): Promise<UserRow> {
    const user = await this.users.findById(userId);
    if (!user) {
      throw new UnauthorizedException('Account no longer exists');
    }
    return user;
  }

  async me(userId: string): Promise<UserResponse> {
    const user = await this.users.findById(userId);
    if (!user) {
      throw new UnauthorizedException('Account no longer exists');
    }
    return UserResponse.fromRow(user);
  }

  private async toAuthResult(user: UserRow): Promise<AuthResult> {
    const token = await this.tokens.signSellerToken(
      {
        sub: user.id,
        email: user.email ?? undefined,
        name: user.name,
        isAdmin: user.isAdmin,
      },
      await this.sessionScope.resolve(user),
    );
    return { user: UserResponse.fromRow(user), token };
  }

  /**
   * Re-mint the caller's session at the scope their account now deserves.
   * Called by the client straight after a contact detail is verified, so
   * proving an email or phone lifts a checkout-created storefront session to a
   * full account session without making the shopper sign out and back in.
   */
  async refreshSession(userId: string): Promise<AuthResult> {
    return this.toAuthResult(await this.requireUser(userId));
  }

  /**
   * Set or change the signed-in account's password.
   *
   * An account made through Google has no hash to prove, so the session it is
   * already holding is the proof - the same standing that lets it place orders
   * or open a shop. Once a password exists it must be typed again to replace
   * it, which is what stops a borrowed screen from quietly taking the account
   * over. Either way the account keeps its Google sign-in; this only adds the
   * second door, and is what makes the console's password login reachable for
   * an owner who has only ever used Google.
   */
  async setPassword(
    userId: string,
    dto: SetPasswordDto,
  ): Promise<UserResponse> {
    const user = await this.requireUser(userId);
    if (user.passwordHash) {
      const ok =
        !!dto.currentPassword &&
        (await bcrypt.compare(dto.currentPassword, user.passwordHash));
      if (!ok) {
        throw new UnauthorizedException({
          statusCode: HttpStatus.UNAUTHORIZED,
          error: 'CurrentPasswordInvalid',
          message: 'Your current password is not right.',
        });
      }
    }
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    await this.users.updatePassword(user.id, passwordHash);
    return UserResponse.fromRow({ ...user, passwordHash });
  }
}
