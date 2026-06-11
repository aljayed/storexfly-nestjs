import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import type { UserRow } from '../../database/schema';
import { UserResponse } from '../users/dto/user.response';
import { UsersService } from '../users/users.service';
import type { LoginDto } from './dto/login.dto';
import type { RegisterDto } from './dto/register.dto';
import { OtpService } from './otp.service';
import { TokenService } from './token.service';

const BCRYPT_ROUNDS = 12;

export interface AuthResult {
  user: UserResponse;
  token: string;
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
  ) {}

  async register(dto: RegisterDto): Promise<AuthResult> {
    const existing = await this.users.findByEmail(dto.email);
    if (existing) {
      throw new ConflictException('An account with this email already exists');
    }
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    const user = await this.users.create({
      name: dto.name,
      email: dto.email,
      passwordHash,
      via: 'email',
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
      });
    }
    return this.toAuthResult(user);
  }

  async me(userId: string): Promise<UserResponse> {
    const user = await this.users.findById(userId);
    if (!user) {
      throw new UnauthorizedException('Account no longer exists');
    }
    return UserResponse.fromRow(user);
  }

  private async toAuthResult(user: UserRow): Promise<AuthResult> {
    const token = await this.tokens.signSellerToken({
      sub: user.id,
      email: user.email ?? undefined,
      name: user.name,
      isAdmin: user.isAdmin,
    });
    return { user: UserResponse.fromRow(user), token };
  }
}
