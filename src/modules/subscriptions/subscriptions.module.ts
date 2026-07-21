import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { CouponsModule } from '../coupons/coupons.module';
import { ReferralsModule } from '../referrals/referrals.module';
import { SubscriptionsController } from './subscriptions.controller';
import { SubscriptionsService } from './subscriptions.service';

/**
 * Platform billing: the per-shop monthly subscription (operator-priced), the one-off
 * shop-creation fee (coupon-discountable), auto-debit renewals and the shop
 * live/off switch. Exported so ShopsModule can gate shop creation on a paid
 * fee.
 */
@Module({
  imports: [BillingModule, CouponsModule, ReferralsModule],
  controllers: [SubscriptionsController],
  providers: [SubscriptionsService],
  exports: [SubscriptionsService],
})
export class SubscriptionsModule {}
