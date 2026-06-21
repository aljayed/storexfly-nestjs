import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BrandingModule } from '../branding/branding.module';
import { CouponsModule } from '../coupons/coupons.module';
import { PlatformAuthController } from './platform-auth.controller';
import { PlatformAuthService } from './platform-auth.service';
import { PlatformBrandingController } from './platform-branding.controller';
import { PlatformCouponsController } from './platform-coupons.controller';
import { PlatformOverviewController } from './platform-overview.controller';
import { PlatformOverviewService } from './platform-overview.service';

/**
 * The platform-admin console API (hoomri.com/platform-admin): operator
 * login against env-configured credentials, coupon management, branding, and
 * cross-shop shop/customer listings.
 */
@Module({
  imports: [AuthModule, CouponsModule, BrandingModule],
  controllers: [
    PlatformAuthController,
    PlatformCouponsController,
    PlatformBrandingController,
    PlatformOverviewController,
  ],
  providers: [PlatformAuthService, PlatformOverviewService],
})
export class PlatformModule {}
