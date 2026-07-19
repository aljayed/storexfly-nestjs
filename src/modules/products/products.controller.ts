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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { AdminJwtAuthGuard } from '../../common/guards/admin-jwt-auth.guard';
import { RequirePerm } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ShopScopeGuard } from '../../common/guards/shop-scope.guard';
import { CreateProductDto } from './dto/create-product.dto';
import { ProductListQuery } from './dto/product-list.query';
import { UpdateProductDto } from './dto/update-product.dto';
import { ProductsService } from './products.service';

@ApiTags('products')
@Controller()
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  // ── Public storefront / product page ─────────────────────────
  @Public()
  @Get('shops/:handle/products')
  @ApiOperation({ summary: 'List a shop catalog (optional ?cat= filter)' })
  list(@Param('handle') handle: string, @Query() query: ProductListQuery) {
    return this.products.listByHandle(handle, query.cat);
  }

  @Public()
  @Get('shops/:handle/products/:slug')
  @ApiOperation({ summary: 'Product page — product + reviews' })
  getOne(@Param('handle') handle: string, @Param('slug') slug: string) {
    return this.products.getBySlug(handle, slug);
  }

  // ── Admin (console) ──────────────────────────────────────────
  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @ApiBearerAuth()
  @RequirePerm('items.view')
  @Get('shops/:shopId/items')
  @ApiOperation({ summary: 'Admin: list every item in the shop' })
  listForShop(@Param('shopId') shopId: string) {
    return this.products.listForShop(shopId);
  }

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @ApiBearerAuth()
  @RequirePerm('items.add')
  @Post('shops/:shopId/products')
  @ApiOperation({ summary: 'Admin: create a product' })
  create(@Param('shopId') shopId: string, @Body() dto: CreateProductDto) {
    return this.products.create(shopId, dto);
  }

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @ApiBearerAuth()
  @RequirePerm('items.edit')
  @Patch('shops/:shopId/products/:id')
  @ApiOperation({ summary: 'Admin: update a product (price, stock, …)' })
  update(
    @Param('shopId') shopId: string,
    @Param('id') id: string,
    @Body() dto: UpdateProductDto,
  ) {
    return this.products.update(shopId, id, dto);
  }

  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @ApiBearerAuth()
  @RequirePerm('items.delete')
  @Delete('shops/:shopId/products/:id')
  @ApiOperation({ summary: 'Admin: delete a product' })
  remove(@Param('shopId') shopId: string, @Param('id') id: string) {
    return this.products.remove(shopId, id);
  }
}
