import { Module } from '@nestjs/common';
import { BillingSettingsService } from './billing-settings.service';

/**
 * The operator-set platform price. Controller-free on purpose: subscriptions,
 * coupons and the platform console all import it, and a route-bearing module
 * would drag those into an import cycle.
 */
@Module({
  providers: [BillingSettingsService],
  exports: [BillingSettingsService],
})
export class BillingModule {}
