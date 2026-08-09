import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { StorefrontSession } from '../../common/decorators/storefront-session.decorator';
import type { AccountPrincipal } from '../../common/types/principal';
import { OrdersService } from '../orders/orders.service';
import { BuyerService } from './buyer.service';
import { BuyerOrderDetailQueryDto } from './dto/buyer-order-detail.query.dto';
import { CancelOrderDto } from './dto/cancel-order.dto';
import { ClaimOrderDto } from './dto/claim-order.dto';
import { RespondAdjustmentDto } from './dto/respond-adjustment.dto';

/** Storefront order actions for the signed-in account (authed by the global
 *  account JWT guard). Orders match the account by email. */
@StorefrontSession()
@ApiTags('buyer')
@ApiBearerAuth()
@Controller('buyer/orders')
export class BuyerOrdersController {
  constructor(
    private readonly buyers: BuyerService,
    private readonly orders: OrdersService,
  ) {}

  /** Order matching is email-keyed, so these actions need the account's email. */
  private requireEmail(user: AccountPrincipal): string {
    if (!user.email) {
      throw new ForbiddenException('Add an email to your account first.');
    }
    return user.email;
  }

  /** Query string, not a path segment: an order reference starts with '#',
   *  which no proxy is guaranteed to hand through inside a path. */
  @Get('detail')
  @ApiOperation({
    summary: 'Account: one own order in full (lines, totals, amount history)',
  })
  detail(
    @CurrentUser() user: AccountPrincipal,
    @Query() query: BuyerOrderDetailQueryDto,
  ) {
    return this.orders.orderDetailForBuyer(
      this.requireEmail(user),
      query.shopId,
      query.reference,
    );
  }

  @Post('claim')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Account: link a guest order to the signed-in account' })
  claim(@CurrentUser() user: AccountPrincipal, @Body() dto: ClaimOrderDto) {
    return this.buyers.claimOrder(user.id, dto);
  }

  @Post('cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Account: cancel an own order the shop hasn't confirmed yet",
  })
  cancel(@CurrentUser() user: AccountPrincipal, @Body() dto: CancelOrderDto) {
    return this.orders.cancelByBuyer(
      this.requireEmail(user),
      dto.shopId,
      dto.reference,
    );
  }

  @Post('adjustment/respond')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Account: approve or decline a seller's order-amount change",
  })
  respondAdjustment(
    @CurrentUser() user: AccountPrincipal,
    @Body() dto: RespondAdjustmentDto,
  ) {
    return this.orders.respondToAdjustmentByBuyer(
      this.requireEmail(user),
      dto.shopId,
      dto.reference,
      dto.adjustmentId,
      dto.approve,
    );
  }
}
