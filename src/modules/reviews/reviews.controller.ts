import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { BuyerJwtAuthGuard } from '../../common/guards/buyer-jwt-auth.guard';
import type { BuyerPrincipal } from '../../common/types/principal';
import { ReviewResponse } from '../products/dto/product-detail.response';
import {
  CreateReviewDto,
  ReviewEligibilityResponse,
} from './dto/create-review.dto';
import { ReviewsService } from './reviews.service';

/**
 * Buyer reviews on a product. Both routes require a buyer session; the service
 * additionally enforces a verified purchase. Reviews are displayed via the
 * public product-detail endpoint.
 */
@ApiTags('reviews')
@Controller('shops/:handle/products/:slug')
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Public()
  @UseGuards(BuyerJwtAuthGuard)
  @ApiBearerAuth()
  @Get('review-eligibility')
  @ApiOperation({ summary: 'Buyer: may I review this product?' })
  @ApiOkResponse({ type: ReviewEligibilityResponse })
  eligibility(
    @Param('handle') handle: string,
    @Param('slug') slug: string,
    @CurrentUser() buyer: BuyerPrincipal,
  ) {
    return this.reviews.eligibility(handle, slug, buyer);
  }

  @Public()
  @UseGuards(BuyerJwtAuthGuard)
  @ApiBearerAuth()
  @Post('reviews')
  @ApiOperation({ summary: 'Buyer: write a review (verified purchase only)' })
  @ApiOkResponse({ type: ReviewResponse })
  create(
    @Param('handle') handle: string,
    @Param('slug') slug: string,
    @CurrentUser() buyer: BuyerPrincipal,
    @Body() dto: CreateReviewDto,
  ) {
    return this.reviews.create(handle, slug, buyer, dto);
  }

  @Public()
  @UseGuards(BuyerJwtAuthGuard)
  @ApiBearerAuth()
  @Patch('reviews/:id')
  @ApiOperation({ summary: 'Buyer: edit your own review' })
  @ApiOkResponse({ type: ReviewResponse })
  update(
    @Param('handle') handle: string,
    @Param('slug') slug: string,
    @Param('id') id: string,
    @CurrentUser() buyer: BuyerPrincipal,
    @Body() dto: CreateReviewDto,
  ) {
    return this.reviews.update(handle, slug, id, buyer, dto);
  }

  @Public()
  @UseGuards(BuyerJwtAuthGuard)
  @ApiBearerAuth()
  @Delete('reviews/:id')
  @ApiOperation({ summary: 'Buyer: delete your own review' })
  remove(
    @Param('handle') handle: string,
    @Param('slug') slug: string,
    @Param('id') id: string,
    @CurrentUser() buyer: BuyerPrincipal,
  ) {
    return this.reviews.remove(handle, slug, id, buyer);
  }
}
