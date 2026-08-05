import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { BlockedWordsModule } from '../blocked-words/blocked-words.module';
import { MailModule } from '../mail/mail.module';
import { ShopsModule } from '../shops/shops.module';
import { UsersModule } from '../users/users.module';
import { AdminAuthController } from './admin-auth.controller';
import { AdminAuthService } from './admin-auth.service';
import { AdminUsersService } from './admin-users.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { EmailOtpService } from './email-otp.service';
import { OtpService } from './otp.service';
import { PasswordResetService } from './password-reset.service';
import { SessionScopeService } from './session-scope.service';
import { TokenService } from './token.service';
import { AdminJwtStrategy } from './strategies/admin-jwt.strategy';
import { GoogleStrategy } from './strategies/google.strategy';
import { JwtStrategy } from './strategies/jwt.strategy';
import { PlatformJwtStrategy } from './strategies/platform-jwt.strategy';

@Module({
  imports: [
    PassportModule,
    // Secrets/lifetimes are applied per-token in TokenService, so register empty.
    JwtModule.register({}),
    UsersModule,
    ShopsModule,
    MailModule,
    BlockedWordsModule,
  ],
  controllers: [AuthController, AdminAuthController],
  providers: [
    AuthService,
    AdminAuthService,
    AdminUsersService,
    TokenService,
    OtpService,
    EmailOtpService,
    PasswordResetService,
    SessionScopeService,
    JwtStrategy,
    AdminJwtStrategy,
    PlatformJwtStrategy,
    GoogleStrategy,
  ],
  exports: [
    AdminUsersService,
    TokenService,
    EmailOtpService,
    SessionScopeService,
  ],
})
export class AuthModule {}
