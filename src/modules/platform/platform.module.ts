import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CouponsModule } from '../coupons/coupons.module';
import { PlatformAuthController } from './platform-auth.controller';
import { PlatformAuthService } from './platform-auth.service';
import { PlatformCouponsController } from './platform-coupons.controller';

/**
 * The platform-admin console API (storexfly.com/platform-admin): operator
 * login against env-configured credentials and coupon management.
 */
@Module({
  imports: [AuthModule, CouponsModule],
  controllers: [PlatformAuthController, PlatformCouponsController],
  providers: [PlatformAuthService],
})
export class PlatformModule {}
