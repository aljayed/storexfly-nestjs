import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { BuyerJwtAuthGuard } from '../../common/guards/buyer-jwt-auth.guard';
import type { BuyerPrincipal } from '../../common/types/principal';
import { OrdersService } from '../orders/orders.service';
import { BuyerService } from './buyer.service';
import { CancelOrderDto } from './dto/cancel-order.dto';
import { ClaimOrderDto } from './dto/claim-order.dto';
import { RespondAdjustmentDto } from './dto/respond-adjustment.dto';

/** Buyer-authed order actions (separate from the seller order pipeline). */
@ApiTags('buyer')
// @Public() opts out of the global seller JWT guard; the buyer guard below is
// what authenticates these routes (same pattern as the other buyer routes).
@Public()
@UseGuards(BuyerJwtAuthGuard)
@ApiBearerAuth()
@Controller('buyer/orders')
export class BuyerOrdersController {
  constructor(
    private readonly buyers: BuyerService,
    private readonly orders: OrdersService,
  ) {}

  @Post('claim')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Buyer: link a guest order to the signed-in account' })
  claim(@CurrentUser() user: BuyerPrincipal, @Body() dto: ClaimOrderDto) {
    return this.buyers.claimOrder(user.id, dto);
  }

  @Post('cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Buyer: cancel an own order the shop hasn't confirmed yet",
  })
  cancel(@CurrentUser() user: BuyerPrincipal, @Body() dto: CancelOrderDto) {
    return this.orders.cancelByBuyer(user.email, dto.shopId, dto.reference);
  }

  @Post('adjustment/respond')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Buyer: approve or decline a seller's order-amount change",
  })
  respondAdjustment(
    @CurrentUser() user: BuyerPrincipal,
    @Body() dto: RespondAdjustmentDto,
  ) {
    return this.orders.respondToAdjustmentByBuyer(
      user.email,
      dto.shopId,
      dto.reference,
      dto.adjustmentId,
      dto.approve,
    );
  }
}
