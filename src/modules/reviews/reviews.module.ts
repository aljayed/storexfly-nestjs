import { Module } from '@nestjs/common';
import { BuyerModule } from '../buyer/buyer.module';
import { ShopsModule } from '../shops/shops.module';
import { ReviewsController } from './reviews.controller';
import { ReviewsService } from './reviews.service';

/**
 * Buyer-written product reviews. Depends on ShopsModule to resolve the public
 * shop handle, and on BuyerModule so the `buyer-jwt` strategy is available to
 * the guard on the review routes.
 */
@Module({
  imports: [ShopsModule, BuyerModule],
  controllers: [ReviewsController],
  providers: [ReviewsService],
})
export class ReviewsModule {}
