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
  Req,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { RequirePerm } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AdminJwtAuthGuard } from '../../common/guards/admin-jwt-auth.guard';
import { ShopScopeGuard } from '../../common/guards/shop-scope.guard';
import { BookCourierDto } from './dto/book-courier.dto';
import { callerFrom } from '../risk/checkout-caller';
import { PhoneProofService } from '../risk/phone-proof.service';
import {
  CheckoutDto,
  CheckoutPhoneConfirmDto,
  CheckoutPhoneStartDto,
  CheckoutPreflightDto,
  CouponQuoteDto,
} from './dto/checkout.dto';
import { OrderQueryDto } from './dto/order-query.dto';
import { RequestAdjustmentDto } from './dto/request-adjustment.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { OrdersService } from './orders.service';

@ApiTags('orders')
@Controller()
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly jwt: JwtService,
    private readonly phoneProof: PhoneProofService,
    private readonly config: ConfigService,
  ) {}

  // ── Public buyer checkout ────────────────────────────────────
  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('checkout')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Place an order (inline product-page checkout)' })
  checkout(@Body() dto: CheckoutDto, @Req() req: Request) {
    return this.orders.checkout(dto, callerFrom(req, this.accountOf(req)));
  }

  /**
   * Which identity steps this checkout will ask for - whether the buyer has to
   * sign in, and whether they will be asked to confirm their number.
   *
   * The storefront calls this while the buyer is still filling the form, so it
   * can say the steps are coming rather than springing them on the button.
   * Nothing here withholds a payment method or refuses an order. The answer is
   * advisory: checkout re-runs the same checks and is what actually enforces
   * them.
   */
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('checkout/preflight')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'What this checkout must satisfy before it is placed',
  })
  preflight(@Body() dto: CheckoutPreflightDto, @Req() req: Request) {
    return this.orders.preflight(dto, callerFrom(req, this.accountOf(req)));
  }

  /**
   * Checkout is public, so a signed-in buyer is not resolved by a guard.
   * Read the bearer token when one is there and ignore it when it does not
   * verify: being signed in only ever relaxes the checks below, so a bad
   * token costs the caller nothing but the benefit of the doubt.
   */
  private accountOf(req: Request): string | null {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return null;
    try {
      const claims = this.jwt.verify<{ sub?: string; typ?: string }>(
        header.slice(7),
        { secret: this.config.getOrThrow<string>('jwt.secret') },
      );
      return claims.typ === 'seller' && claims.sub ? claims.sub : null;
    } catch {
      return null;
    }
  }

  /**
   * Phone verification for a checkout. A guest has no account to mark as
   * verified, so confirming the code hands back a short-lived proof that
   * `POST /checkout` accepts in its place. A signed-in caller gets the number
   * written to their account as well, which is what makes this a once-ever
   * step rather than one they meet again on their next repeat order.
   */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('checkout/phone/start')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Text a verification code for a checkout' })
  startPhone(@Body() dto: CheckoutPhoneStartDto) {
    return this.phoneProof.start(dto.phone);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('checkout/phone/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Exchange the code for a checkout phone proof' })
  confirmPhone(@Body() dto: CheckoutPhoneConfirmDto, @Req() req: Request) {
    return this.phoneProof.confirm(dto.phone, dto.code, this.accountOf(req));
  }

  /**
   * Preview a discount code against the cart the buyer is looking at. Rate
   * limited harder than checkout: this is the one endpoint that would let
   * someone guess a shop's codes by brute force.
   */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('checkout/coupon')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Check what a coupon code takes off this cart' })
  quoteCoupon(@Body() dto: CouponQuoteDto) {
    return this.orders.quoteCoupon(dto);
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
  @ApiOperation({
    summary:
      'Admin: advance order status (seller-drivable up to HandedOver; Shipped/Delivered come from the courier)',
  })
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

  // ── Buyer-approved amount adjustments ────────────────────────
  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @RequirePerm('orders.manage')
  @ApiBearerAuth()
  @Post('shops/:shopId/orders/:id/adjustment')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Admin: propose a new order total for the buyer to approve',
  })
  requestAdjustment(
    @Param('shopId') shopId: string,
    @Param('id') id: string,
    @Body() dto: RequestAdjustmentDto,
  ) {
    return this.orders.requestAmountAdjustment(shopId, id, dto);
  }

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @RequirePerm('orders.manage')
  @ApiBearerAuth()
  @Post('shops/:shopId/orders/:id/adjustment/:adjustmentId/withdraw')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Admin: withdraw a pending amount change' })
  withdrawAdjustment(
    @Param('shopId') shopId: string,
    @Param('id') id: string,
    @Param('adjustmentId') adjustmentId: string,
  ) {
    return this.orders.withdrawAmountAdjustment(shopId, id, adjustmentId);
  }

  // ── Courier (the platform's own account) ─────────────────────
  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @RequirePerm('orders.manage')
  @ApiBearerAuth()
  @Post('shops/:shopId/orders/:id/courier')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Admin: book a parcel on the platform courier (COD amount auto-set; Pathao needs cityId/zoneId)',
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
