import { Module } from '@nestjs/common';
import { BlockedWordsModule } from '../blocked-words/blocked-words.module';
import { GatewaysModule } from '../gateways/gateways.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { ShopCouriersController } from './shop-couriers.controller';
import { ShopsController } from './shops.controller';
import { ShopsService } from './shops.service';

@Module({
  imports: [SubscriptionsModule, BlockedWordsModule, GatewaysModule],
  controllers: [ShopsController, ShopCouriersController],
  providers: [ShopsService],
  exports: [ShopsService],
})
export class ShopsModule {}
