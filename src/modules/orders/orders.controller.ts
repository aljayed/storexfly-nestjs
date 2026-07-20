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
import { RequirePerm } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AdminJwtAuthGuard } from '../../common/guards/admin-jwt-auth.guard';
import { ShopScopeGuard } from '../../common/guards/shop-scope.guard';
import { BookCourierDto } from './dto/book-courier.dto';
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
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @RequirePerm('orders.manage')
  @ApiBearerAuth()
  @Get('shops/:shopId/orders')
  @ApiOperation({
    summary: 'Admin: paginated order list (status/channel/q filters + sort)',
  })
  list(@Param('shopId') shopId: string, @Query() query: OrderQueryDto) {
    return this.orders.list(shopId, query);
  }

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @RequirePerm('orders.manage')
  @ApiBearerAuth()
  @Get('shops/:shopId/orders/:id')
  @ApiOperation({ summary: 'Admin: get one order' })
  getOne(@Param('shopId') shopId: string, @Param('id') id: string) {
    return this.orders.getById(shopId, id);
  }

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @RequirePerm('orders.manage')
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
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @RequirePerm('orders.manage')
  @ApiBearerAuth()
  @Post('shops/:shopId/orders/:id/refund')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Admin: refund an order' })
  refund(@Param('shopId') shopId: string, @Param('id') id: string) {
    return this.orders.refund(shopId, id);
  }

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @RequirePerm('orders.manage')
  @ApiBearerAuth()
  @Post('shops/:shopId/orders/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Admin: cancel an unconfirmed order (restocks items)',
  })
  cancel(@Param('shopId') shopId: string, @Param('id') id: string) {
    return this.orders.cancel(shopId, id);
  }

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @RequirePerm('orders.manage')
  @ApiBearerAuth()
  @Post('shops/:shopId/orders/:id/mark-paid')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Admin: confirm a direct-transfer payment was received (Due → Paid)',
  })
  markPaid(@Param('shopId') shopId: string, @Param('id') id: string) {
    return this.orders.markPaid(shopId, id);
  }

  // ── Courier (whichever provider the shop enabled) ────────────
  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @RequirePerm('orders.manage')
  @ApiBearerAuth()
  @Post('shops/:shopId/orders/:id/courier')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Admin: book a parcel with the shop's courier (COD amount auto-set; Pathao needs cityId/zoneId)",
  })
  bookCourier(
    @Param('shopId') shopId: string,
    @Param('id') id: string,
    @Body() dto: BookCourierDto,
  ) {
    return this.orders.bookCourier(shopId, id, dto);
  }

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @RequirePerm('orders.manage')
  @ApiBearerAuth()
  @Get('shops/:shopId/orders/:id/courier')
  @ApiOperation({
    summary: 'Admin: refresh the courier delivery status for an order',
  })
  refreshCourier(@Param('shopId') shopId: string, @Param('id') id: string) {
    return this.orders.refreshCourier(shopId, id);
  }
}
