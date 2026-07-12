import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { AuthModule } from '../auth/auth.module';
import { BlockedWordsModule } from '../blocked-words/blocked-words.module';
import { BuyerAuthController } from './buyer-auth.controller';
import { BuyerOrdersController } from './buyer-orders.controller';
import { BuyerProfileController } from './buyer-profile.controller';
import { BuyerService } from './buyer.service';
import { BuyerJwtStrategy } from './strategies/buyer-jwt.strategy';

/**
 * Buyer (shopper) accounts and their JWT session. Imports AuthModule for the
 * shared {@link TokenService}; registers the `buyer-jwt` passport strategy.
 */
@Module({
  imports: [AuthModule, PassportModule, BlockedWordsModule],
  controllers: [
    BuyerAuthController,
    BuyerOrdersController,
    BuyerProfileController,
  ],
  providers: [BuyerService, BuyerJwtStrategy],
  exports: [BuyerService],
})
export class BuyerModule {}
