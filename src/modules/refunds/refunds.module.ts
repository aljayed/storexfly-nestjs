import { Module } from '@nestjs/common';
import { GatewaysModule } from '../gateways/gateways.module';
import { RefundsService } from './refunds.service';

/**
 * Sending money back through the gateway that took it - a buyer's order, or a
 * seller's platform payment that bought nothing. Its own module because both
 * the orders side and the billing side need it, and orders already depends
 * on billing.
 */
@Module({
  imports: [GatewaysModule],
  providers: [RefundsService],
  exports: [RefundsService],
})
export class RefundsModule {}
