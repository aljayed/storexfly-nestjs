import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
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
import { RequirePerm } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ShopScopeGuard } from '../../common/guards/shop-scope.guard';
import type { SellerPrincipal } from '../../common/types/principal';
import { CouponsService } from '../coupons/coupons.service';
import { CouponPreviewResponse } from '../coupons/dto/coupon.response';
import { BuyCreditsDto } from './dto/buy-credits.dto';
import { SetAutoDebitDto } from './dto/set-auto-debit.dto';
import { SetBillingModeDto } from './dto/set-billing-mode.dto';
import { SetShopLiveDto } from './dto/set-shop-live.dto';
import {
  CreditPackResponse,
  SubscriptionResponse,
} from './dto/subscription.response';
import { BillingSettingsService } from '../billing/billing-settings.service';
import { SubscriptionsService } from './subscriptions.service';

@ApiTags('subscriptions')
@Controller()
export class SubscriptionsController {
  constructor(
    private readonly subscriptions: SubscriptionsService,
    private readonly coupons: CouponsService,
    private readonly billing: BillingSettingsService,
  ) {}

  // ── Public pricing ────────────────────────────────────────────
  // The landing page quotes the packs and the commission rate before anyone
  // has signed in, so these are the billing routes with no principal.
  @Public()
  @Get('billing/pricing')
  @ApiOperation({
    summary:
      'The credit packs on sale, the commission rate, the credit cap and any live launch offer',
  })
  async pricing() {
    // The launch coupon rides along so the landing page can advertise it, but
    // only while it would actually be accepted at checkout.
    const [pricing, launchOffer] = await Promise.all([
      this.billing.pricing(),
      this.coupons.launchOffer(),
    ]);
    return { ...pricing, launchOffer };
  }

  @Public()
  @Get('billing/packs')
  @ApiOperation({ summary: 'The credit packs on sale, cheapest first' })
  @ApiOkResponse({ type: [CreditPackResponse] })
  async packs() {
    return (await this.billing.packs()).map(CreditPackResponse.from);
  }

  @ApiBearerAuth()
  @Get('billing/coupon-preview')
  @ApiOperation({ summary: 'Dry-run a coupon against a credit pack' })
  @ApiOkResponse({ type: CouponPreviewResponse })
  async previewCoupon(
    @CurrentUser() user: SellerPrincipal,
    @Query('code') code = '',
    @Query('packCode') packCode?: string,
  ) {
    const pack =
      (await this.billing.packByCode(packCode)) ??
      (await this.billing.entryPack());
    return this.coupons.preview(code, user.id, pack?.priceCents);
  }

  // ── Admin console (Subscription page) ─────────────────────────
  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @RequirePerm('subscription.manage')
  @ApiBearerAuth()
  @Get('shops/:shopId/subscription')
  @ApiOperation({ summary: 'Admin: billing state + payment history' })
  @ApiOkResponse({ type: SubscriptionResponse })
  getForShop(@Param('shopId') shopId: string) {
    return this.subscriptions.getForShop(shopId);
  }

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @RequirePerm('subscription.manage')
  @ApiBearerAuth()
  @Post('shops/:shopId/subscription/credits')
  @ApiOperation({ summary: 'Admin: buy a sales-credit pack (dummy gateway)' })
  @ApiOkResponse({ type: SubscriptionResponse })
  buyCredits(@Param('shopId') shopId: string, @Body() dto: BuyCreditsDto) {
    return this.subscriptions.buyCredits(
      shopId,
      dto.packCode,
      dto.couponCode,
      dto.refSlug,
    );
  }

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @RequirePerm('subscription.manage')
  @ApiBearerAuth()
  @Post('shops/:shopId/subscription/mode')
  @ApiOperation({
    summary:
      'Admin: switch between pre-paid credits and post-paid commission (needs a verified licence)',
  })
  @ApiOkResponse({ type: SubscriptionResponse })
  setMode(@Param('shopId') shopId: string, @Body() dto: SetBillingModeDto) {
    return this.subscriptions.setBillingMode(shopId, dto.mode);
  }

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @RequirePerm('subscription.manage')
  @ApiBearerAuth()
  @Post('shops/:shopId/subscription/pay')
  @ApiOperation({ summary: 'Admin: settle an outstanding commission bill' })
  @ApiOkResponse({ type: SubscriptionResponse })
  payNow(@Param('shopId') shopId: string) {
    return this.subscriptions.payNow(shopId);
  }

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @RequirePerm('subscription.manage')
  @ApiBearerAuth()
  @Post('shops/:shopId/subscription/cancel')
  @ApiOperation({ summary: 'Admin: cancel billing (shop goes off)' })
  @ApiOkResponse({ type: SubscriptionResponse })
  cancel(@Param('shopId') shopId: string) {
    return this.subscriptions.cancel(shopId);
  }

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @RequirePerm('subscription.manage')
  @ApiBearerAuth()
  @Post('shops/:shopId/subscription/resume')
  @ApiOperation({ summary: 'Admin: resume a cancelled shop' })
  @ApiOkResponse({ type: SubscriptionResponse })
  resume(@Param('shopId') shopId: string) {
    return this.subscriptions.resume(shopId);
  }

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @RequirePerm('subscription.manage')
  @ApiBearerAuth()
  @Patch('shops/:shopId/subscription/auto-debit')
  @ApiOperation({
    summary: 'Admin: toggle automatic collection of the monthly commission',
  })
  @ApiOkResponse({ type: SubscriptionResponse })
  setAutoDebit(@Param('shopId') shopId: string, @Body() dto: SetAutoDebitDto) {
    return this.subscriptions.setAutoDebit(shopId, dto.enabled);
  }

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @RequirePerm('subscription.manage')
  @ApiBearerAuth()
  @Patch('shops/:shopId/live')
  @ApiOperation({ summary: 'Admin: turn the storefront on or off' })
  setLive(@Param('shopId') shopId: string, @Body() dto: SetShopLiveDto) {
    return this.subscriptions.setShopLive(shopId, dto.live);
  }
}
