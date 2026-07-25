import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { AuthModule } from '../auth/auth.module';
import { BlockedWordsModule } from '../blocked-words/blocked-words.module';
import { OrdersModule } from '../orders/orders.module';
import { BuyerAuthController } from './buyer-auth.controller';
import { BuyerOrdersController } from './buyer-orders.controller';
import { BuyerProfileController } from './buyer-profile.controller';
import { BuyerService } from './buyer.service';

/**
 * Storefront-shopper account flows (register/login/profile), operating on the
 * unified `users` account. Authenticated storefront routes use the global
 * account JWT guard — there is no separate buyer session anymore.
 */
@Module({
  imports: [AuthModule, PassportModule, BlockedWordsModule, OrdersModule],
  controllers: [
    BuyerAuthController,
    BuyerOrdersController,
    BuyerProfileController,
  ],
  providers: [BuyerService],
  exports: [BuyerService],
})
export class BuyerModule {}
