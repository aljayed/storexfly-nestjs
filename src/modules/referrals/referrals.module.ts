import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { ReferralsController } from './referrals.controller';
import { ReferralsService } from './referrals.service';

/**
 * Referral links tied to platform coupons. The service is exported for the
 * platform-admin module (CRUD from the console) and the subscriptions module
 * (signup attribution at payment time); the controller here is the public
 * slug-resolution endpoint the storefront calls.
 */
@Module({
  imports: [BillingModule],
  controllers: [ReferralsController],
  providers: [ReferralsService],
  exports: [ReferralsService],
})
export class ReferralsModule {}
