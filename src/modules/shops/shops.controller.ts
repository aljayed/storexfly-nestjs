import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { SHOP_CATEGORIES } from '../../database/schema/enums';
import type { SellerPrincipal } from '../../common/types/principal';
import { CheckHandleQuery } from './dto/check-handle.query';
import { CreateShopDto } from './dto/create-shop.dto';
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

  @Public()
  @Get(':handle')
  @ApiOperation({ summary: 'Public storefront load (shop + featured products)' })
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
