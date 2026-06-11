import {
  Body,
  Controller,
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
import { AdminJwtAuthGuard } from '../../common/guards/admin-jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ShopScopeGuard } from '../../common/guards/shop-scope.guard';
import type { SellerPrincipal } from '../../common/types/principal';
import { SetAutoDebitDto } from './dto/set-auto-debit.dto';
import { SetShopLiveDto } from './dto/set-shop-live.dto';
import {
  ShopCreditResponse,
  SubscriptionResponse,
} from './dto/subscription.response';
import { SubscriptionsService } from './subscriptions.service';

@ApiTags('subscriptions')
@Controller()
export class SubscriptionsController {
  constructor(private readonly subscriptions: SubscriptionsService) {}

  // ── Seller (onboarding wizard) ────────────────────────────────
  @ApiBearerAuth()
  @Get('billing/shop-credit')
  @ApiOperation({ summary: 'Has the seller paid the shop-creation fee?' })
  @ApiOkResponse({ type: ShopCreditResponse })
  getShopCredit(@CurrentUser() user: SellerPrincipal) {
    return this.subscriptions.getShopCreationCredit(user.id);
  }

  @ApiBearerAuth()
  @Post('billing/shop-credit')
  @ApiOperation({ summary: 'Pay the ৳1,199 shop-creation fee (dummy gateway)' })
  @ApiOkResponse({ type: ShopCreditResponse })
  payShopCredit(@CurrentUser() user: SellerPrincipal) {
    return this.subscriptions.payShopCreationFee(user.id);
  }

  // ── Admin console (Subscription page) ─────────────────────────
  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @ApiBearerAuth()
  @Get('shops/:shopId/subscription')
  @ApiOperation({ summary: 'Admin: subscription status + payment history' })
  @ApiOkResponse({ type: SubscriptionResponse })
  getForShop(@Param('shopId') shopId: string) {
    return this.subscriptions.getForShop(shopId);
  }

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @ApiBearerAuth()
  @Post('shops/:shopId/subscription/pay')
  @ApiOperation({ summary: 'Admin: manually pay an overdue renewal' })
  @ApiOkResponse({ type: SubscriptionResponse })
  payNow(@Param('shopId') shopId: string) {
    return this.subscriptions.payNow(shopId);
  }

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @ApiBearerAuth()
  @Post('shops/:shopId/subscription/cancel')
  @ApiOperation({ summary: 'Admin: cancel the subscription (shop goes off)' })
  @ApiOkResponse({ type: SubscriptionResponse })
  cancel(@Param('shopId') shopId: string) {
    return this.subscriptions.cancel(shopId);
  }

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @ApiBearerAuth()
  @Post('shops/:shopId/subscription/resume')
  @ApiOperation({ summary: 'Admin: resume a cancelled subscription' })
  @ApiOkResponse({ type: SubscriptionResponse })
  resume(@Param('shopId') shopId: string) {
    return this.subscriptions.resume(shopId);
  }

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @ApiBearerAuth()
  @Patch('shops/:shopId/subscription/auto-debit')
  @ApiOperation({ summary: 'Admin: toggle automatic monthly debit' })
  @ApiOkResponse({ type: SubscriptionResponse })
  setAutoDebit(@Param('shopId') shopId: string, @Body() dto: SetAutoDebitDto) {
    return this.subscriptions.setAutoDebit(shopId, dto.enabled);
  }

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @ApiBearerAuth()
  @Patch('shops/:shopId/live')
  @ApiOperation({ summary: 'Admin: turn the storefront on or off' })
  setLive(@Param('shopId') shopId: string, @Body() dto: SetShopLiveDto) {
    return this.subscriptions.setShopLive(shopId, dto.live);
  }
}
