import {
  Body,
  Controller,
  Delete,
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
import { ApplyCouponDto } from './dto/apply-coupon.dto';
import { ChangePlanDto } from './dto/change-plan.dto';
import { PayShopCreditDto } from './dto/pay-shop-credit.dto';
import { SetAutoDebitDto } from './dto/set-auto-debit.dto';
import { SetAutoResetDto } from './dto/set-auto-reset.dto';
import { SetAutoScaleDto } from './dto/set-auto-scale.dto';
import { SetShopLiveDto } from './dto/set-shop-live.dto';
import {
  PlanResponse,
  ShopCreditResponse,
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
  // The landing page and the create-shop wizard quote the fee before anyone
  // has signed in, so this is the one billing route with no principal.
  @Public()
  @Get('billing/pricing')
  @ApiOperation({
    summary: 'The entry monthly per-shop fee, plus the whole plan ladder',
  })
  pricing() {
    return this.billing.pricing();
  }

  @Public()
  @Get('billing/plans')
  @ApiOperation({ summary: 'The plans on sale, cheapest first' })
  @ApiOkResponse({ type: [PlanResponse] })
  async plans() {
    return (await this.billing.plans()).map(PlanResponse.from);
  }

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
  @ApiOperation({ summary: 'Pay the shop-creation fee (dummy gateway)' })
  @ApiOkResponse({ type: ShopCreditResponse })
  payShopCredit(
    @CurrentUser() user: SellerPrincipal,
    @Body() dto: PayShopCreditDto,
  ) {
    return this.subscriptions.payShopCreationFee(
      user.id,
      dto.couponCode,
      dto.refSlug,
    );
  }

  @ApiBearerAuth()
  @Get('billing/coupon-preview')
  @ApiOperation({
    summary: 'Dry-run a coupon against the shop-creation fee',
  })
  @ApiOkResponse({ type: CouponPreviewResponse })
  previewCoupon(
    @CurrentUser() user: SellerPrincipal,
    @Query('code') code = '',
  ) {
    return this.coupons.preview(code, user.id);
  }

  // ── Admin console (Subscription page) ─────────────────────────
  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @RequirePerm('subscription.manage')
  @ApiBearerAuth()
  @Get('shops/:shopId/subscription')
  @ApiOperation({ summary: 'Admin: subscription status + payment history' })
  @ApiOkResponse({ type: SubscriptionResponse })
  getForShop(@Param('shopId') shopId: string) {
    return this.subscriptions.getForShop(shopId);
  }

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @RequirePerm('subscription.manage')
  @ApiBearerAuth()
  @Post('shops/:shopId/subscription/pay')
  @ApiOperation({ summary: 'Admin: manually pay an overdue renewal' })
  @ApiOkResponse({ type: SubscriptionResponse })
  payNow(@Param('shopId') shopId: string) {
    return this.subscriptions.payNow(shopId);
  }

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @RequirePerm('subscription.manage')
  @ApiBearerAuth()
  @Post('shops/:shopId/subscription/activate')
  @ApiOperation({
    summary:
      'Admin: upgrade a free shop to the paid plan (consumes the paid shop credit)',
  })
  @ApiOkResponse({ type: SubscriptionResponse })
  activate(@Param('shopId') shopId: string) {
    return this.subscriptions.activateForExistingShop(shopId);
  }

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @RequirePerm('subscription.manage')
  @ApiBearerAuth()
  @Post('shops/:shopId/subscription/cancel')
  @ApiOperation({ summary: 'Admin: cancel the subscription (shop goes off)' })
  @ApiOkResponse({ type: SubscriptionResponse })
  cancel(@Param('shopId') shopId: string) {
    return this.subscriptions.cancel(shopId);
  }

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @RequirePerm('subscription.manage')
  @ApiBearerAuth()
  @Post('shops/:shopId/subscription/resume')
  @ApiOperation({ summary: 'Admin: resume a cancelled subscription' })
  @ApiOkResponse({ type: SubscriptionResponse })
  resume(@Param('shopId') shopId: string) {
    return this.subscriptions.resume(shopId);
  }

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @RequirePerm('subscription.manage')
  @ApiBearerAuth()
  @Post('shops/:shopId/subscription/coupon')
  @ApiOperation({ summary: 'Admin: apply a coupon to the next renewal' })
  @ApiOkResponse({ type: SubscriptionResponse })
  applyCoupon(@Param('shopId') shopId: string, @Body() dto: ApplyCouponDto) {
    return this.subscriptions.applyCoupon(shopId, dto.code);
  }

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @RequirePerm('subscription.manage')
  @ApiBearerAuth()
  @Delete('shops/:shopId/subscription/coupon')
  @ApiOperation({ summary: 'Admin: remove the pending renewal coupon' })
  @ApiOkResponse({ type: SubscriptionResponse })
  removeCoupon(@Param('shopId') shopId: string) {
    return this.subscriptions.removeCoupon(shopId);
  }

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @RequirePerm('subscription.manage')
  @ApiBearerAuth()
  @Post('shops/:shopId/subscription/plan')
  @ApiOperation({
    summary:
      'Admin: change plan — up starts now (prorated), down starts at the next renewal',
  })
  @ApiOkResponse({ type: SubscriptionResponse })
  changePlan(@Param('shopId') shopId: string, @Body() dto: ChangePlanDto) {
    return this.subscriptions.changePlan(shopId, dto.code);
  }

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @RequirePerm('subscription.manage')
  @ApiBearerAuth()
  @Patch('shops/:shopId/subscription/auto-scale')
  @ApiOperation({
    summary: 'Admin: toggle automatic upgrade at 100% of the sales cap',
  })
  @ApiOkResponse({ type: SubscriptionResponse })
  setAutoScale(@Param('shopId') shopId: string, @Body() dto: SetAutoScaleDto) {
    return this.subscriptions.setAutoScale(shopId, dto.enabled);
  }

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @RequirePerm('subscription.manage')
  @ApiBearerAuth()
  @Patch('shops/:shopId/subscription/auto-reset')
  @ApiOperation({
    summary:
      'Admin: toggle "start every period on the entry plan" (needs auto-scale)',
  })
  @ApiOkResponse({ type: SubscriptionResponse })
  setAutoReset(@Param('shopId') shopId: string, @Body() dto: SetAutoResetDto) {
    return this.subscriptions.setAutoReset(shopId, dto.enabled);
  }

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @RequirePerm('subscription.manage')
  @ApiBearerAuth()
  @Patch('shops/:shopId/subscription/auto-debit')
  @ApiOperation({ summary: 'Admin: toggle automatic monthly debit' })
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
