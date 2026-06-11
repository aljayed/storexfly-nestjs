import { Module } from '@nestjs/common';
import { CouponsModule } from '../coupons/coupons.module';
import { SubscriptionsController } from './subscriptions.controller';
import { SubscriptionsService } from './subscriptions.service';

/**
 * Platform billing: the per-shop monthly subscription (৳1,199), the one-off
 * shop-creation fee (coupon-discountable), auto-debit renewals and the shop
 * live/off switch. Exported so ShopsModule can gate shop creation on a paid
 * fee.
 */
@Module({
  imports: [CouponsModule],
  controllers: [SubscriptionsController],
  providers: [SubscriptionsService],
  exports: [SubscriptionsService],
})
export class SubscriptionsModule {}
