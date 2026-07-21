import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { BlockedWordsModule } from '../blocked-words/blocked-words.module';
import { BrandingModule } from '../branding/branding.module';
import { CouponsModule } from '../coupons/coupons.module';
import { GatewaysModule } from '../gateways/gateways.module';
import { PlatformAuthController } from './platform-auth.controller';
import { PlatformAuthService } from './platform-auth.service';
import { PlatformBillingController } from './platform-billing.controller';
import { PlatformBlockedWordsController } from './platform-blocked-words.controller';
import { PlatformBrandingController } from './platform-branding.controller';
import { PlatformCouponsController } from './platform-coupons.controller';
import { PlatformGatewaysController } from './platform-gateways.controller';
import { PlatformOverviewController } from './platform-overview.controller';
import { PlatformOverviewService } from './platform-overview.service';

/**
 * The platform-admin console API (hoomri.com/platform-admin): operator
 * login against env-configured credentials, coupon management, branding,
 * cross-shop shop/customer listings, and blocked-words moderation.
 */
@Module({
  imports: [
    AuthModule,
    BillingModule,
    CouponsModule,
    BrandingModule,
    BlockedWordsModule,
    GatewaysModule,
  ],
  controllers: [
    PlatformAuthController,
    PlatformBillingController,
    PlatformCouponsController,
    PlatformBrandingController,
    PlatformGatewaysController,
    PlatformOverviewController,
    PlatformBlockedWordsController,
  ],
  providers: [PlatformAuthService, PlatformOverviewService],
})
export class PlatformModule {}
