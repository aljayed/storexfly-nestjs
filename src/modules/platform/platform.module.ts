import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { BlockedWordsModule } from '../blocked-words/blocked-words.module';
import { BrandingModule } from '../branding/branding.module';
import { CouponsModule } from '../coupons/coupons.module';
import { GatewaysModule } from '../gateways/gateways.module';
import { MailModule } from '../mail/mail.module';
import { NoticesModule } from '../notices/notices.module';
import { ReferralsModule } from '../referrals/referrals.module';
import { PlatformAuthController } from './platform-auth.controller';
import { PlatformAuthService } from './platform-auth.service';
import { PlatformBillingController } from './platform-billing.controller';
import { PlatformBlockedWordsController } from './platform-blocked-words.controller';
import { PlatformBrandingController } from './platform-branding.controller';
import { PlatformCouponsController } from './platform-coupons.controller';
import { PlatformCouriersController } from './platform-couriers.controller';
import { PlatformGatewaysController } from './platform-gateways.controller';
import { PlatformMailController } from './platform-mail.controller';
import { PlatformOverviewController } from './platform-overview.controller';
import { PlatformOverviewService } from './platform-overview.service';
import { PlatformReferralsController } from './platform-referrals.controller';

/**
 * The platform-admin console API (hoomri.com/platform-admin): operator
 * login against env-configured credentials, coupon management, branding,
 * cross-shop shop/customer listings, blocked-words moderation, and the staff
 * mailboxes on the platform's own mail domain.
 */
@Module({
  imports: [
    AuthModule,
    BillingModule,
    CouponsModule,
    ReferralsModule,
    BrandingModule,
    BlockedWordsModule,
    GatewaysModule,
    MailModule,
    NoticesModule,
  ],
  controllers: [
    PlatformAuthController,
    PlatformBillingController,
    PlatformCouponsController,
    PlatformReferralsController,
    PlatformBrandingController,
    PlatformGatewaysController,
    PlatformMailController,
    PlatformCouriersController,
    PlatformOverviewController,
    PlatformBlockedWordsController,
  ],
  providers: [PlatformAuthService, PlatformOverviewService],
})
export class PlatformModule {}
