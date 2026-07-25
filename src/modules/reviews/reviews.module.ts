import { Module } from '@nestjs/common';
import { ShopsModule } from '../shops/shops.module';
import { ReviewsController } from './reviews.controller';
import { ReviewsService } from './reviews.service';

/**
 * Product reviews. Depends on ShopsModule to resolve the public shop handle; the
 * review routes authenticate with the global account JWT guard (no buyer-jwt).
 */
@Module({
  imports: [ShopsModule],
  controllers: [ReviewsController],
  providers: [ReviewsService],
})
export class ReviewsModule {}
