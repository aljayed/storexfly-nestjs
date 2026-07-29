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
 * Seller-console CRUD for a shop's buyer-facing discount codes. The buyer side
 * (previewing a code against a cart) lives on the checkout controller, where
 * the cart is already priced.
 */
@ApiTags('shop-coupons')
@Controller()
export class ShopCouponsController {
  constructor(private readonly coupons: ShopCouponsService) {}

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
