import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { BuyerJwtAuthGuard } from '../../common/guards/buyer-jwt-auth.guard';
import type { BuyerPrincipal } from '../../common/types/principal';
import { BuyerService } from './buyer.service';
import { UpdateBuyerProfileDto } from './dto/buyer-overview.dto';

/** Buyer self-service profile — account info, order history and reviews. */
@ApiTags('buyer')
// @Public() opts out of the global *seller* JWT guard; the buyer guard below is
// what actually authenticates these routes (same pattern as the buyer /me route).
@Public()
@UseGuards(BuyerJwtAuthGuard)
@ApiBearerAuth()
@Controller('buyer/profile')
export class BuyerProfileController {
  constructor(private readonly buyers: BuyerService) {}

  @Get()
  @ApiOperation({ summary: 'Buyer: profile overview (account, orders, reviews)' })
  overview(@CurrentUser() user: BuyerPrincipal) {
    return this.buyers.overview(user.id);
  }

  @Patch()
  @ApiOperation({ summary: 'Buyer: update name and saved checkout details' })
  updateProfile(
    @CurrentUser() user: BuyerPrincipal,
    @Body() dto: UpdateBuyerProfileDto,
  ) {
    return this.buyers.updateProfile(user.id, dto);
  }
}
