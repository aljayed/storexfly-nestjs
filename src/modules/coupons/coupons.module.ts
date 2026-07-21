import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { CouponsService } from './coupons.service';

/**
 * Platform coupons (discounts on the shop-creation fee). The service is
 * exported for the subscriptions module (redemption at payment time) and the
 * platform-admin module (CRUD from the platform console).
 */
@Module({
  imports: [BillingModule],
  providers: [CouponsService],
  exports: [CouponsService],
})
export class CouponsModule {}
