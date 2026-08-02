import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { RequirePerm, Roles } from '../../common/decorators/roles.decorator';
import { AdminJwtAuthGuard } from '../../common/guards/admin-jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ShopScopeGuard } from '../../common/guards/shop-scope.guard';
import { SHOP_CATEGORIES } from '../../database/schema/enums';
import type { SellerPrincipal } from '../../common/types/principal';
import { CheckHandleQuery } from './dto/check-handle.query';
import { CreateShopDto } from './dto/create-shop.dto';
import { DeleteShopDto } from './dto/delete-shop.dto';
import { PayoutBankDto } from './dto/payout-bank.dto';
import { DiscoverResponse } from './dto/discover.response';
import { SubmitKycDto } from './dto/kyc.dto';
import { KycResponse } from './dto/kyc.response';
import { ShopResponse } from './dto/shop.response';
import { UpdateShopDto } from './dto/update-shop.dto';
import { ShopsService } from './shops.service';

@ApiTags('shops')
@Controller('shops')
export class ShopsController {
  constructor(private readonly shops: ShopsService) {}

  @Public()
  @Get('check-handle')
  @ApiOperation({ summary: 'Live handle-availability check (onboarding)' })
  checkHandle(@Query() query: CheckHandleQuery) {
    return this.shops.checkHandle(query.handle);
  }

  // Declared before `:handle` so "categories" never resolves as a shop.
  @Public()
  @Get('categories')
  @ApiOperation({ summary: 'All shop categories (onboarding + settings)' })
  categories(): { categories: string[] } {
    return { categories: SHOP_CATEGORIES };
  }

  // Declared before `:handle` so "discover" never resolves as a shop.
  @Public()
  @Get('discover')
  @ApiOperation({
    summary: 'Public marketplace feed (live shops + newest products)',
  })
  @ApiOkResponse({ type: DiscoverResponse })
  discover() {
    return this.shops.discover();
  }

  @ApiBearerAuth()
  @Post()
  @ApiOperation({ summary: 'Create a shop (create-shop wizard submit)' })
  @ApiOkResponse({ type: ShopResponse })
  create(@CurrentUser() user: SellerPrincipal, @Body() dto: CreateShopDto) {
    return this.shops.create(user.id, dto);
  }

  @ApiBearerAuth()
  @Get('mine')
  @ApiOperation({ summary: "List the signed-in seller's shops" })
  mine(@CurrentUser() user: SellerPrincipal) {
    return this.shops.listForOwner(user.id);
  }

  @ApiBearerAuth()
  @Get(':id/kyc')
  @ApiOperation({ summary: 'Read the shop business verification (owner only)' })
  @ApiOkResponse({ type: KycResponse })
  getKyc(@CurrentUser() user: SellerPrincipal, @Param('id') id: string) {
    return this.shops.getKyc(user.id, id);
  }

  @ApiBearerAuth()
  @Patch(':id/kyc')
  @ApiOperation({ summary: 'Submit/update business verification (owner only)' })
  @ApiOkResponse({ type: KycResponse })
  submitKyc(
    @CurrentUser() user: SellerPrincipal,
    @Param('id') id: string,
    @Body() dto: SubmitKycDto,
  ) {
    return this.shops.submitKyc(user.id, id, dto);
  }

  // ── Admin console (admin JWT - works for invited staff who have no
  //    seller session; ShopScopeGuard pins access to the token's shop) ──
  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @ApiBearerAuth()
  @Get(':shopId/console')
  @ApiOperation({ summary: 'Admin: the shop the console session is scoped to' })
  @ApiOkResponse({ type: ShopResponse })
  consoleShop(@Param('shopId') shopId: string) {
    return this.shops.getById(shopId);
  }

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @RequirePerm('settings.manage')
  @ApiBearerAuth()
  @Patch(':shopId/console')
  @ApiOperation({ summary: 'Admin: update shop settings (full access only)' })
  @ApiOkResponse({ type: ShopResponse })
  consoleUpdate(@Param('shopId') shopId: string, @Body() dto: UpdateShopDto) {
    return this.shops.updateFromConsole(shopId, dto);
  }

  // ── Payout bank account (settlement transfer destination) ──
  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @RequirePerm('settlements.view')
  @ApiBearerAuth()
  @Get(':shopId/payout-bank')
  @ApiOperation({ summary: 'Admin: the payout bank account on file' })
  getPayoutBank(@Param('shopId') shopId: string) {
    return this.shops.getPayoutBank(shopId);
  }

  // Changing where the money goes is owner-only, like deleting the shop.
  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @Roles('owner')
  @ApiBearerAuth()
  @Put(':shopId/payout-bank')
  @ApiOperation({ summary: 'Admin (owner): set the payout bank account' })
  setPayoutBank(@Param('shopId') shopId: string, @Body() dto: PayoutBankDto) {
    return this.shops.setPayoutBank(shopId, {
      bankName: dto.bankName,
      accountName: dto.accountName,
      accountNumber: dto.accountNumber,
      branch: dto.branch?.trim() ? dto.branch : undefined,
    });
  }

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @Roles('owner')
  @ApiBearerAuth()
  @Delete(':shopId/payout-bank')
  @ApiOperation({ summary: 'Admin (owner): remove the payout bank account' })
  clearPayoutBank(@Param('shopId') shopId: string) {
    return this.shops.setPayoutBank(shopId, null);
  }

  // ── Shop deletion - owner role only, confirmed by an email OTP ──
  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @Roles('owner')
  @ApiBearerAuth()
  @Get(':shopId/delete-precheck')
  @ApiOperation({
    summary:
      'Admin (owner): what blocks deletion (in-progress orders) and what is still owed (unsettled payouts)',
  })
  deletePrecheck(@Param('shopId') shopId: string) {
    return this.shops.deletePrecheck(shopId);
  }

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @Roles('owner')
  @ApiBearerAuth()
  @Post(':shopId/delete-otp')
  @ApiOperation({
    summary: 'Admin (owner): email a code confirming shop deletion',
  })
  requestDeleteOtp(@Param('shopId') shopId: string) {
    return this.shops.requestDeleteOtp(shopId);
  }

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @Roles('owner')
  @ApiBearerAuth()
  @Post(':shopId/delete')
  @ApiOperation({
    summary:
      'Admin (owner): verify the emailed code, cancel billing and delete the shop',
  })
  deleteShop(@Param('shopId') shopId: string, @Body() dto: DeleteShopDto) {
    return this.shops.deleteWithOtp(shopId, dto.code);
  }

  @Public()
  @Get(':handle')
  @ApiOperation({
    summary: 'Public storefront load (shop + featured products)',
  })
  getByHandle(@Param('handle') handle: string) {
    return this.shops.getByHandle(handle);
  }

  @ApiBearerAuth()
  @Patch(':id')
  @ApiOperation({ summary: 'Update shop brand/tagline/category (owner only)' })
  @ApiOkResponse({ type: ShopResponse })
  update(
    @CurrentUser() user: SellerPrincipal,
    @Param('id') id: string,
    @Body() dto: UpdateShopDto,
  ) {
    return this.shops.update(user.id, id, dto);
  }
}
