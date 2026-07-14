import { Module } from '@nestjs/common';
import { ShopsModule } from '../shops/shops.module';
import { PaymentMethodsController } from './payment-methods.controller';
import { PaymentMethodsService } from './payment-methods.service';
import { PlatformSettlementsController } from './platform-settlements.controller';
import { SettlementsController } from './settlements.controller';
import { SettlementsService } from './settlements.service';

/**
 * Monthly payout accounting for prepaid orders: the seller-facing breakdown
 * (per shop), the platform-operator console that records the payouts, and
 * the platform-managed payment-method catalog (with per-method fee rates)
 * the math runs on. PaymentMethodsService is exported so checkout can
 * validate the method a buyer picked.
 */
@Module({
  imports: [ShopsModule],
  controllers: [
    SettlementsController,
    PlatformSettlementsController,
    PaymentMethodsController,
  ],
  providers: [SettlementsService, PaymentMethodsService],
  exports: [PaymentMethodsService],
})
export class SettlementsModule {}
