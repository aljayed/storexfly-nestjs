import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { StorefrontSession } from '../../common/decorators/storefront-session.decorator';
import type { AccountPrincipal } from '../../common/types/principal';
import { ReviewResponse } from '../products/dto/product-detail.response';
import {
  CreateReviewDto,
  ReviewEligibilityResponse,
} from './dto/create-review.dto';
import { ReviewsService } from './reviews.service';

/**
 * Product reviews. All routes require a signed-in account (the global account
 * JWT guard); the service additionally enforces a verified purchase. Reviews are
 * displayed via the public product-detail endpoint.
 */
@StorefrontSession()
@ApiTags('reviews')
@ApiBearerAuth()
@Controller('shops/:handle/products/:slug')
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get('review-eligibility')
  @ApiOperation({ summary: 'Account: may I review this product?' })
  @ApiOkResponse({ type: ReviewEligibilityResponse })
  eligibility(
    @Param('handle') handle: string,
    @Param('slug') slug: string,
    @CurrentUser() buyer: AccountPrincipal,
  ) {
    return this.reviews.eligibility(handle, slug, buyer);
  }

  @Post('reviews')
  @ApiOperation({ summary: 'Account: write a review (verified purchase only)' })
  @ApiOkResponse({ type: ReviewResponse })
  create(
    @Param('handle') handle: string,
    @Param('slug') slug: string,
    @CurrentUser() buyer: AccountPrincipal,
    @Body() dto: CreateReviewDto,
  ) {
    return this.reviews.create(handle, slug, buyer, dto);
  }

  @Patch('reviews/:id')
  @ApiOperation({ summary: 'Account: edit your own review' })
  @ApiOkResponse({ type: ReviewResponse })
  update(
    @Param('handle') handle: string,
    @Param('slug') slug: string,
    @Param('id') id: string,
    @CurrentUser() buyer: AccountPrincipal,
    @Body() dto: CreateReviewDto,
  ) {
    return this.reviews.update(handle, slug, id, buyer, dto);
  }

  @Delete('reviews/:id')
  @ApiOperation({ summary: 'Account: delete your own review' })
  remove(
    @Param('handle') handle: string,
    @Param('slug') slug: string,
    @Param('id') id: string,
    @CurrentUser() buyer: AccountPrincipal,
  ) {
    return this.reviews.remove(handle, slug, id, buyer);
  }
}
