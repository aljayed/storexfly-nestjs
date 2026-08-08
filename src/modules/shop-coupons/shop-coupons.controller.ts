import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
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
  CreateShopCouponDto,
  UpdateShopCouponDto,
} from './dto/create-shop-coupon.dto';
import { ShopCouponsService } from './shop-coupons.service';

/**
 * Seller-console CRUD for a shop's buyer-facing discount codes, plus the one
 * public read a shared coupon link needs. Pricing a code against a cart lives
 * on the checkout controller, where the cart is already priced.
 */
@ApiTags('shop-coupons')
@Controller()
export class ShopCouponsController {
  constructor(private readonly coupons: ShopCouponsService) {}

  /**
   * Terms of a code arriving on a shared link, so the storefront can apply it
   * on sight and quote the discounted price.
   *
   * A seller runs ads on one link, so this is hit once by every buyer who
   * clicks it - and mobile carriers here put thousands of them behind a single
   * NAT address. The limit is therefore well above a person's own use while
   * still refusing the thousands of tries that guessing a shop's codes needs.
   */
  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('shops/:shopId/coupon/:code')
  @ApiOperation({ summary: 'Resolve a coupon code shared as a link' })
  resolve(@Param('shopId') shopId: string, @Param('code') code: string) {
    return this.coupons.resolvePublic(shopId, code);
  }

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @RequirePerm('coupons.manage')
  @ApiBearerAuth()
  @Get('shops/:shopId/coupons')
  @ApiOperation({ summary: 'Admin: list every coupon of the shop' })
  list(@Param('shopId') shopId: string) {
    return this.coupons.listForShop(shopId);
  }

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @RequirePerm('coupons.manage')
  @ApiBearerAuth()
  @Post('shops/:shopId/coupons')
  @ApiOperation({ summary: 'Admin: create a buyer coupon' })
  create(@Param('shopId') shopId: string, @Body() dto: CreateShopCouponDto) {
    return this.coupons.create(shopId, dto);
  }

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @RequirePerm('coupons.manage')
  @ApiBearerAuth()
  @Patch('shops/:shopId/coupons/:id')
  @ApiOperation({ summary: 'Admin: update a coupon' })
  update(
    @Param('shopId') shopId: string,
    @Param('id') id: string,
    @Body() dto: UpdateShopCouponDto,
  ) {
    return this.coupons.update(shopId, id, dto);
  }

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @RequirePerm('coupons.manage')
  @ApiBearerAuth()
  @Delete('shops/:shopId/coupons/:id')
  @ApiOperation({ summary: 'Admin: delete a coupon' })
  remove(@Param('shopId') shopId: string, @Param('id') id: string) {
    return this.coupons.remove(shopId, id);
  }
}
