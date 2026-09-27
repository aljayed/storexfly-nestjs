import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { RequirePerm } from '../../common/decorators/roles.decorator';
import { AdminJwtAuthGuard } from '../../common/guards/admin-jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ShopScopeGuard } from '../../common/guards/shop-scope.guard';
import { ReviewReplyDto, ShopReviewsQuery } from './dto/create-review.dto';
import { ReviewsService } from './reviews.service';

/**
 * Seller console: read the shop's reviews and answer them in public. `@Public`
 * only lifts the global account guard - the admin guards below replace it.
 */
@ApiTags('reviews')
@ApiBearerAuth()
@Public()
@UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
@RequirePerm('reviews.manage')
@Controller('shops/:shopId/reviews')
export class ShopReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get()
  @ApiOperation({ summary: "Admin: the shop's reviews, newest first" })
  list(@Param('shopId') shopId: string, @Query() query: ShopReviewsQuery) {
    return this.reviews.listForShop(shopId, query);
  }

  @Put(':id/reply')
  @ApiOperation({ summary: 'Admin: post or edit the reply to a review' })
  reply(
    @Param('shopId') shopId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewReplyDto,
  ) {
    return this.reviews.reply(shopId, id, dto.body);
  }

  @Delete(':id/reply')
  @ApiOperation({ summary: 'Admin: remove the reply to a review' })
  removeReply(
    @Param('shopId') shopId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.reviews.removeReply(shopId, id);
  }
}
