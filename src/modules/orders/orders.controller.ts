import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { AdminJwtAuthGuard } from '../../common/guards/admin-jwt-auth.guard';
import { ShopScopeGuard } from '../../common/guards/shop-scope.guard';
import { CheckoutDto } from './dto/checkout.dto';
import { OrderQueryDto } from './dto/order-query.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { OrdersService } from './orders.service';

@ApiTags('orders')
@Controller()
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  // ── Public buyer checkout ────────────────────────────────────
  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('checkout')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Place an order (inline product-page checkout)' })
  checkout(@Body() dto: CheckoutDto) {
    return this.orders.checkout(dto);
  }

  // ── Admin order pipeline ─────────────────────────────────────
  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard)
  @ApiBearerAuth()
  @Get('shops/:shopId/orders')
  @ApiOperation({
    summary: 'Admin: paginated order list (status/channel/q filters + sort)',
  })
  list(@Param('shopId') shopId: string, @Query() query: OrderQueryDto) {
    return this.orders.list(shopId, query);
  }

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard)
  @ApiBearerAuth()
  @Get('shops/:shopId/orders/:id')
  @ApiOperation({ summary: 'Admin: get one order' })
  getOne(@Param('shopId') shopId: string, @Param('id') id: string) {
    return this.orders.getById(shopId, id);
  }

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard)
  @ApiBearerAuth()
  @Patch('shops/:shopId/orders/:id/status')
  @ApiOperation({ summary: 'Admin: advance order status' })
  updateStatus(
    @Param('shopId') shopId: string,
    @Param('id') id: string,
    @Body() dto: UpdateOrderStatusDto,
  ) {
    return this.orders.updateStatus(shopId, id, dto.status);
  }

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard)
  @ApiBearerAuth()
  @Post('shops/:shopId/orders/:id/refund')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Admin: refund an order' })
  refund(@Param('shopId') shopId: string, @Param('id') id: string) {
    return this.orders.refund(shopId, id);
  }

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard)
  @ApiBearerAuth()
  @Post('shops/:shopId/orders/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Admin: cancel an unconfirmed order (restocks items)' })
  cancel(@Param('shopId') shopId: string, @Param('id') id: string) {
    return this.orders.cancel(shopId, id);
  }
}
