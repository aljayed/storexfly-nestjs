import { Module } from '@nestjs/common';
import { BlockedWordsModule } from '../blocked-words/blocked-words.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { ShopsController } from './shops.controller';
import { ShopsService } from './shops.service';

@Module({
  imports: [SubscriptionsModule, BlockedWordsModule],
  controllers: [ShopsController],
  providers: [ShopsService],
  exports: [ShopsService],
})
export class ShopsModule {}
