import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { OtpService, type PhoneCodeSent } from '../auth/otp.service';
import { UsersService } from '../users/users.service';

const SCOPE = 'checkout-phone';
/** Long enough to finish a checkout, short enough that a proof is not reusable
 *  tomorrow if it leaks out of a shared browser. */
const PROOF_TTL = '20m';

interface PhoneProofClaims {
  typ: 'phone-proof';
  phone: string;
}

/** Bare national number - the platform's one phone shape. */
export function normalizePhone(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\D/g, '').replace(/^880/, '').replace(/^0+/, '');
}

/**
 * Phone verification for people who have no account to hang it off.
 *
 * A guest cannot "verify their phone" the way a signed-in account does -
 * there is no row to mark. So confirming the code mints a short-lived signed
 * proof instead, which checkout accepts in place of a verified account. The
 * proof names the number it was issued for, so it cannot be replayed against
 * a different one.
 */
@Injectable()
export class PhoneProofService {
  private readonly secret: string;
  private readonly isProduction = process.env.NODE_ENV === 'production';

  constructor(
    private readonly otp: OtpService,
    private readonly jwt: JwtService,
    private readonly users: UsersService,
    config: ConfigService,
  ) {
    this.secret = config.getOrThrow<string>('jwt.secret');
  }

  /**
   * Text a code to the number.
   *
   * With no SMS gateway configured the code comes back in the response so the
   * flow can be exercised - but never in production, where this endpoint is
   * public and handing out the code would make the whole check ornamental.
   */
  async start(phone: string): Promise<PhoneCodeSent> {
    const normalized = normalizePhone(phone);
    if (!normalized)
      throw new BadRequestException('Enter a valid phone number');
    if (!this.canDeliver) {
      throw new ServiceUnavailableException(
        'Phone verification is unavailable right now.',
      );
    }
    const issued = await this.otp.issue(normalized, SCOPE);
    return {
      ok: true,
      retryAfterSeconds: issued.retryAfterSeconds,
      ...(this.otp.smsEnabled || this.isProduction
        ? {}
        : { devCode: issued.code }),
    };
  }

  /** True when a code can actually reach the recipient. */
  get canDeliver(): boolean {
    return this.otp.smsEnabled || !this.isProduction;
  }

  /**
   * Exchange a correct code for the proof checkout will accept.
   *
   * When the caller is signed in, the same answer is also written to their
   * account - this is an OTP to a number they hold, which is exactly what the
   * account's own phone verification asks for, so there is no reason to make
   * them prove it twice. That write is what makes this a once-in-a-lifetime
   * step: from here on the account is verified and checkout stops asking.
   *
   * The proof is returned either way. It is what the order in flight carries,
   * and it is all a guest gets.
   */
  async confirm(
    phone: string,
    code: string,
    accountId?: string | null,
  ): Promise<{ proof: string }> {
    const normalized = normalizePhone(phone);
    if (!this.otp.verify(normalized, code, SCOPE)) {
      throw new BadRequestException('That code is not right, or it expired');
    }
    if (accountId) {
      // Stored in the same shape the account flow uses, so one number reads as
      // one number to `findByVerifiedPhone` whichever door proved it.
      const e164 = `+880${normalized}`;
      // One number belongs to one account, so a number already verified
      // elsewhere is not claimed by this one. The order still goes through -
      // this endpoint exists to let a checkout finish, and refusing here would
      // put a wall in front of a buyer who just answered a code correctly.
      // They are simply asked again on their next repeat order, and the
      // create-shop wizard is where a number is moved between accounts.
      const owner = await this.users.findByVerifiedPhone(e164);
      if (!owner || owner.id === accountId) {
        await this.users.setVerifiedPhone(accountId, e164);
      }
    }
    const proof = await this.jwt.signAsync(
      { typ: 'phone-proof', phone: normalized } satisfies PhoneProofClaims,
      { secret: this.secret, expiresIn: PROOF_TTL },
    );
    return { proof };
  }

  /** True when `proof` was issued for this very number and is still current. */
  async holds(proof: string | undefined, phone: string): Promise<boolean> {
    if (!proof) return false;
    try {
      const claims = await this.jwt.verifyAsync<PhoneProofClaims>(proof, {
        secret: this.secret,
      });
      return (
        claims.typ === 'phone-proof' &&
        !!claims.phone &&
        claims.phone === normalizePhone(phone)
      );
    } catch {
      return false;
    }
  }
}
