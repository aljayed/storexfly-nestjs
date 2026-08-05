import {
  ConflictException,
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
import { OtpService } from './otp.service';
import { SessionScopeService } from './session-scope.service';
import { TokenService } from './token.service';

const BCRYPT_ROUNDS = 12;
const REGISTER_OTP_SCOPE = 'seller-register';
/** OTP scopes for proving contact details on an *existing* account. */
const VERIFY_PHONE_SCOPE = 'account-phone';
const VERIFY_EMAIL_SCOPE = 'account-email';

export interface AuthResult {
  user: UserResponse;
  token: string;
}

interface PendingRegistration {
  name: string;
  email: string;
  passwordHash: string;
}

/**
 * Seller/buyer authentication: email register/login, Google upsert, and the
 * phone OTP flow. Issues seller-scoped JWTs via {@link TokenService}.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly tokens: TokenService,
    private readonly otp: OtpService,
    private readonly emailOtp: EmailOtpService,
    private readonly blockedWords: BlockedWordsService,
    private readonly sessionScope: SessionScopeService,
  ) {}

  /** Step 1: validate + stash the pending account, email a verification code. */
  async registerStart(dto: RegisterDto): Promise<{ ok: true }> {
    const existing = await this.users.findByEmail(dto.email);
    if (existing) {
      throw new ConflictException('An account with this email already exists');
    }
    await this.blockedWords.assertClean(dto.name);
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    await this.emailOtp.start<PendingRegistration>(
      REGISTER_OTP_SCOPE,
      dto.email,
      { name: dto.name, email: dto.email, passwordHash },
    );
    return { ok: true };
  }

  /** Step 2: verify the code and actually create the account. */
  async registerVerify(email: string, code: string): Promise<AuthResult> {
    const pending = this.emailOtp.verify<PendingRegistration>(
      REGISTER_OTP_SCOPE,
      email,
      code,
    );
    if (!pending) {
      throw new UnauthorizedException('Invalid or expired code');
    }
    const existing = await this.users.findByEmail(pending.email);
    if (existing) {
      throw new ConflictException('An account with this email already exists');
    }
    const user = await this.users.create({
      name: pending.name,
      email: pending.email,
      passwordHash: pending.passwordHash,
      via: 'email',
      emailVerified: true,
    });
    return this.toAuthResult(user);
  }

  async login(dto: LoginDto): Promise<AuthResult> {
    const user = await this.users.findByEmail(dto.email);
    if (!user || !user.passwordHash) {
      throw new UnauthorizedException('Invalid email or password');
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

  async startPhone(phone: string): Promise<{ ok: true }> {
    await this.otp.issue(phone);
    return { ok: true };
  }

  async verifyPhone(phone: string, code: string): Promise<AuthResult> {
    if (!this.otp.verify(phone, code)) {
      throw new UnauthorizedException('Invalid or expired code');
    }
    let user = await this.users.findByPhone(phone);
    if (!user) {
      user = await this.users.create({
        name: phone,
        phone,
        via: 'phone',
        // The OTP just proved this number - record it, or the account would
        // look unverified to the shop-creation gate and to session scoping
        // despite having logged in with the number itself.
        phoneVerified: true,
      });
    } else if (!user.phoneVerified) {
      user = await this.users.setVerifiedPhone(user.id, phone);
    }
    return this.toAuthResult(user);
  }

  // ── Contact verification (prerequisite for creating a shop) ────
  //
  // A shop may only be opened by an account with one verified email *and*
  // one verified phone number, both unique to that account. Registration
  // already proves the email; the phone is proved here. The SMS side is a
  // stub - {@link OtpService} has no gateway yet, so while `smsEnabled` is
  // false the issued code comes back in the response and the console shows
  // it. Nothing else about the flow changes when real SMS lands.

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
  ): Promise<{ ok: true; devCode?: string }> {
    const user = await this.requireUser(userId);
    const owner = await this.users.findByVerifiedPhone(phone);
    if (owner && owner.id !== user.id) {
      throw new ConflictException(
        'This phone number is already verified on another account',
      );
    }
    const code = await this.otp.issue(phone, VERIFY_PHONE_SCOPE);
    return this.otp.smsEnabled ? { ok: true } : { ok: true, devCode: code };
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
}
