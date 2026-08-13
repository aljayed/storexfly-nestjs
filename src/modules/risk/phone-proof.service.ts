import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { OtpService } from '../auth/otp.service';

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
  async start(phone: string): Promise<{ ok: true; devCode?: string }> {
    const normalized = normalizePhone(phone);
    if (!normalized) throw new BadRequestException('Enter a valid phone number');
    if (!this.canDeliver) {
      throw new ServiceUnavailableException(
        'Phone verification is unavailable right now.',
      );
    }
    const code = await this.otp.issue(normalized, SCOPE);
    return this.otp.smsEnabled || this.isProduction
      ? { ok: true }
      : { ok: true, devCode: code };
  }

  /** True when a code can actually reach the recipient. */
  get canDeliver(): boolean {
    return this.otp.smsEnabled || !this.isProduction;
  }

  /** Exchange a correct code for the proof checkout will accept. */
  async confirm(phone: string, code: string): Promise<{ proof: string }> {
    const normalized = normalizePhone(phone);
    if (!this.otp.verify(normalized, code, SCOPE)) {
      throw new BadRequestException('That code is not right, or it expired');
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
