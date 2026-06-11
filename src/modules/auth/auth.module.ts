import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ShopsModule } from '../shops/shops.module';
import { UsersModule } from '../users/users.module';
import { AdminAuthController } from './admin-auth.controller';
import { AdminAuthService } from './admin-auth.service';
import { AdminUsersService } from './admin-users.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { OtpService } from './otp.service';
import { TokenService } from './token.service';
import { AdminJwtStrategy } from './strategies/admin-jwt.strategy';
import { GoogleStrategy } from './strategies/google.strategy';
import { JwtStrategy } from './strategies/jwt.strategy';

@Module({
  imports: [
    PassportModule,
    // Secrets/lifetimes are applied per-token in TokenService, so register empty.
    JwtModule.register({}),
    UsersModule,
    ShopsModule,
  ],
  controllers: [AuthController, AdminAuthController],
  providers: [
    AuthService,
    AdminAuthService,
    AdminUsersService,
    TokenService,
    OtpService,
    JwtStrategy,
    AdminJwtStrategy,
    GoogleStrategy,
  ],
  exports: [AdminUsersService, TokenService],
})
export class AuthModule {}
