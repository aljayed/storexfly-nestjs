import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'crypto';
import { TokenService } from '../auth/token.service';
import type { PlatformLoginDto } from './dto/platform-login.dto';

export interface PlatformAuthResult {
  token: string;
  admin: { email: string; name: string };
}

/**
 * Platform-admin console authentication. There is a single operator identity
 * whose credentials live in the environment (PLATFORM_ADMIN_EMAIL /
 * PLATFORM_ADMIN_PASSWORD) - no database row, so the console works even on an
 * empty database. Comparison is timing-safe via fixed-length digests.
 */
@Injectable()
export class PlatformAuthService {
  constructor(
    private readonly config: ConfigService,
    private readonly tokens: TokenService,
  ) {}

  async login(dto: PlatformLoginDto): Promise<PlatformAuthResult> {
    const email = this.config.getOrThrow<string>('platformAdmin.email');
    const password = this.config.getOrThrow<string>('platformAdmin.password');
    const emailOk = this.safeEqual(dto.email.toLowerCase(), email);
    const passwordOk = this.safeEqual(dto.password, password);
    if (!emailOk || !passwordOk) {
      throw new UnauthorizedException('Invalid email or password');
    }
    const token = await this.tokens.signPlatformToken(email);
    return { token, admin: { email, name: 'Platform Admin' } };
  }

  private safeEqual(a: string, b: string): boolean {
    const digest = (s: string) => createHash('sha256').update(s).digest();
    return timingSafeEqual(digest(a), digest(b));
  }
}
