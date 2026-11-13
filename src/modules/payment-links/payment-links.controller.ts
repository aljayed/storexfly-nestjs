import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { RequirePerm } from '../../common/decorators/roles.decorator';
import { AdminJwtAuthGuard } from '../../common/guards/admin-jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ShopScopeGuard } from '../../common/guards/shop-scope.guard';
import {
  CreatePaymentLinkDto,
  PayPaymentLinkDto,
} from './dto/payment-link.dto';
import { PaymentLinksService } from './payment-links.service';

/**
 * Payment links. The seller's console manages them under the shop; the
 * buyer's page reads and pays one by its token, with no session at all - the
 * token in the URL is the whole of their access.
 */
@ApiTags('payment-links')
@Controller()
export class PaymentLinksController {
  constructor(private readonly links: PaymentLinksService) {}

  /* Asking a buyer for money is taking an order by another route, so it sits
     behind the same permission as the orders themselves. */
  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @RequirePerm('orders.manage')
  @ApiBearerAuth()
  @Get('shops/:shopId/payment-links')
  @ApiOperation({ summary: 'Admin: list the shop’s payment links' })
  list(@Param('shopId') shopId: string) {
    return this.links.listForShop(shopId);
  }

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @RequirePerm('orders.manage')
  @ApiBearerAuth()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('shops/:shopId/payment-links')
  @ApiOperation({ summary: 'Admin: create a payment link' })
  create(@Param('shopId') shopId: string, @Body() dto: CreatePaymentLinkDto) {
    return this.links.create(shopId, dto);
  }

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @RequirePerm('orders.manage')
  @ApiBearerAuth()
  @Post('shops/:shopId/payment-links/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Admin: cancel an unpaid payment link' })
  cancel(
    @Param('shopId') shopId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.links.cancel(shopId, id);
  }

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @RequirePerm('orders.manage')
  @ApiBearerAuth()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('shops/:shopId/payment-links/:id/refund')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Admin: refund a paid payment link' })
  refund(
    @Param('shopId') shopId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.links.refund(shopId, id);
  }

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @RequirePerm('orders.manage')
  @ApiBearerAuth()
  @Delete('shops/:shopId/payment-links/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Admin: delete an unpaid payment link' })
  remove(
    @Param('shopId') shopId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.links.remove(shopId, id);
  }

  /* The page polls this while a payment is being confirmed, so the limit has
     room for that - and is still far below what walking the token space takes. */
  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('payment-links/:token')
  @ApiOperation({ summary: 'Read a payment link by its public token' })
  getPublic(@Param('token') token: string) {
    return this.links.getPublic(token);
  }

  // Each call opens a real session at the gateway, so this one is tight.
  @Public()
  @Throttle({ default: { limit: 8, ttl: 60_000 } })
  @Post('payment-links/:token/pay')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Open a hosted payment for a payment link' })
  pay(@Param('token') token: string, @Body() dto: PayPaymentLinkDto) {
    return this.links.pay(token, dto);
  }
}
