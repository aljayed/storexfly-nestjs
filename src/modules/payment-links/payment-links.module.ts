import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BlockedWordsModule } from '../blocked-words/blocked-words.module';
import { GatewaysModule } from '../gateways/gateways.module';
import { RefundsModule } from '../refunds/refunds.module';
import { SettlementsModule } from '../settlements/settlements.module';
import { ShopsModule } from '../shops/shops.module';
import { PaymentLinksController } from './payment-links.controller';
import { PaymentLinksService } from './payment-links.service';

/**
 * Payment links - a shop asks a buyer for an amount by URL, paid through
 * SSLCommerz. Exported because the return leg of hosted checkout
 * (PaymentsService, in OrdersModule) is what marks a link paid.
 */
@Module({
  imports: [
    ShopsModule,
    AuthModule,
    GatewaysModule,
    SettlementsModule,
    RefundsModule,
    BlockedWordsModule,
  ],
  controllers: [PaymentLinksController],
  providers: [PaymentLinksService],
  exports: [PaymentLinksService],
})
export class PaymentLinksModule {}
