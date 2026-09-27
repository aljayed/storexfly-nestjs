import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
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
import type { AdminPrincipal } from '../../common/types/principal';
import { CreateProductDto } from './dto/create-product.dto';
import {
  ImportProductsDto,
  ImportProductsResponse,
} from './dto/import-products.dto';
import { ProductListQuery } from './dto/product-list.query';
import { UpdateProductDto } from './dto/update-product.dto';
import { ProductsImportService } from './products-import.service';
import { ProductsService } from './products.service';

@ApiTags('products')
@Controller()
export class ProductsController {
  constructor(
    private readonly products: ProductsService,
    private readonly importer: ProductsImportService,
  ) {}

  // ── Public storefront / product page ─────────────────────────
  @Public()
  @Get('shops/:handle/products')
  @ApiOperation({ summary: 'List a shop catalog (optional ?cat= filter)' })
  list(@Param('handle') handle: string, @Query() query: ProductListQuery) {
    return this.products.listByHandle(handle, query.cat);
  }

  @Public()
  @Get('shops/:handle/products/:slug')
  @ApiOperation({ summary: 'Product page - product + reviews' })
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

  /*
   * Needs only items.add at the door: a row that would change an existing
   * item is refused *on that row* for an access level without items.edit, so
   * a staff member's import of new items still goes through.
   */
  @Public()
  @UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
  @ApiBearerAuth()
  @RequirePerm('items.add')
  @HttpCode(200)
  @Post('shops/:shopId/products/import')
  @ApiOperation({
    summary: 'Admin: import products from a spreadsheet, a few rows at a time',
  })
  @ApiOkResponse({ type: ImportProductsResponse })
  importRows(
    @Param('shopId') shopId: string,
    @Body() dto: ImportProductsDto,
    @CurrentUser() admin: AdminPrincipal,
  ): Promise<ImportProductsResponse> {
    return this.importer.importRows(shopId, dto, admin);
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
