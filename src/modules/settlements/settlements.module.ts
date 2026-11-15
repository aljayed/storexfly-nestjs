import { GatewaysModule } from '../gateways/gateways.module';
import { Module, forwardRef } from '@nestjs/common';
import { ServiceFeesModule } from '../service-fees/service-fees.module';
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
  // Payouts are sent net of a shop's service-fee balance, and the fee engine
  // reads the payment-method catalogue from here - each needs the other.
  imports: [GatewaysModule, ShopsModule, forwardRef(() => ServiceFeesModule)],
  controllers: [
    SettlementsController,
    PlatformSettlementsController,
    PaymentMethodsController,
  ],
  providers: [SettlementsService, PaymentMethodsService],
  exports: [PaymentMethodsService],
})
export class SettlementsModule {}
