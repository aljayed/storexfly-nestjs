import { Module, forwardRef } from '@nestjs/common';
import { GatewaysModule } from '../gateways/gateways.module';
import { MailModule } from '../mail/mail.module';
import { SettlementsModule } from '../settlements/settlements.module';
import { ShopsModule } from '../shops/shops.module';
import {
  PlatformServiceFeesController,
  ServiceFeesController,
} from './service-fees.controller';
import { ServiceFeesService } from './service-fees.service';

/**
 * The service fee on money sellers collect themselves: what each shop owes,
 * the seller paying it, and the suspension that follows when they do not.
 * Fees on online payments are not here - those come off the payout, in
 * SettlementsModule.
 */
@Module({
  imports: [
    GatewaysModule,
    MailModule,
    // The payment-method catalogue: which methods a gateway collects.
    forwardRef(() => SettlementsModule),
    // The console guards resolve the shop a request is scoped to.
    ShopsModule,
  ],
  controllers: [ServiceFeesController, PlatformServiceFeesController],
  providers: [ServiceFeesService],
  exports: [ServiceFeesService],
})
export class ServiceFeesModule {}
