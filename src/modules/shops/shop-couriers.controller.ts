import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { Public } from '../../common/decorators/public.decorator';
import { RequirePerm } from '../../common/decorators/roles.decorator';
import { AdminJwtAuthGuard } from '../../common/guards/admin-jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ShopScopeGuard } from '../../common/guards/shop-scope.guard';
import { PathaoService } from '../gateways/pathao.service';
import { ShopCourierSettingsService } from '../gateways/shop-courier-settings.service';

export class UpdateShopSteadfastDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() enabled?: boolean;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  apiKey?: string;
  @ApiPropertyOptional({
    description: 'Write-only; omit to keep the stored value',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  secretKey?: string;
}

export class UpdateShopPathaoDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() enabled?: boolean;
  @ApiPropertyOptional({ description: 'true = Pathao sandbox environment' })
  @IsOptional()
  @IsBoolean()
  sandbox?: boolean;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  clientId?: string;
  @ApiPropertyOptional({
    description: 'Write-only; omit to keep the stored value',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  clientSecret?: string;
  @ApiPropertyOptional({ description: 'Pathao merchant account email' })
  @IsOptional()
  @IsString()
  @MaxLength(254)
  username?: string;
  @ApiPropertyOptional({
    description: 'Write-only; omit to keep the stored value',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  password?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  storeId?: string;
}

class PathaoZonesQuery {
  @Type(() => Number) @IsInt() @Min(1) cityId!: number;
}

class PathaoAreasQuery {
  @Type(() => Number) @IsInt() @Min(1) zoneId!: number;
}

/**
 * Seller console: per-shop courier credentials (Steadfast / Pathao). Secrets
 * are write-only — reads only reveal whether one is stored. The Pathao
 * lookups proxy the merchant API so the settings page can pick a store and
 * the orders page can pick a delivery city/zone at booking time.
 */
@ApiTags('shops')
@Public()
@UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
@ApiBearerAuth()
@Controller('shops/:shopId/courier-settings')
export class ShopCouriersController {
  constructor(
    private readonly settings: ShopCourierSettingsService,
    private readonly pathao: PathaoService,
  ) {}

  @Get()
  @RequirePerm('settings.manage')
  @ApiOperation({ summary: 'Admin: courier settings (secrets masked)' })
  view(@Param('shopId') shopId: string) {
    return this.settings.view(shopId);
  }

  @Patch('steadfast')
  @RequirePerm('settings.manage')
  @ApiOperation({ summary: 'Admin: update Steadfast courier credentials' })
  updateSteadfast(
    @Param('shopId') shopId: string,
    @Body() dto: UpdateShopSteadfastDto,
  ) {
    return this.settings.updateSteadfast(shopId, dto);
  }

  @Patch('pathao')
  @RequirePerm('settings.manage')
  @ApiOperation({ summary: 'Admin: update Pathao courier credentials' })
  updatePathao(
    @Param('shopId') shopId: string,
    @Body() dto: UpdateShopPathaoDto,
  ) {
    return this.settings.updatePathao(shopId, dto);
  }

  @Get('pathao/stores')
  @RequirePerm('settings.manage')
  @ApiOperation({
    summary: 'Admin: Pathao stores on the saved credentials (store picker)',
  })
  async pathaoStores(@Param('shopId') shopId: string) {
    const config = await this.requirePathao(shopId);
    return { stores: await this.pathao.stores(config) };
  }

  @Get('active')
  @RequirePerm('orders.manage')
  @ApiOperation({
    summary: 'Admin: which courier bookings go through (null = manual)',
  })
  async active(@Param('shopId') shopId: string) {
    const active = await this.settings.activeCourier(shopId);
    return { provider: active?.provider ?? null };
  }

  // The booking modal lookups run under orders.manage so invited staff who
  // can manage orders (but not settings) can still book parcels.
  @Get('pathao/cities')
  @RequirePerm('orders.manage')
  @ApiOperation({ summary: 'Admin: Pathao city list (booking modal)' })
  async pathaoCities(@Param('shopId') shopId: string) {
    const config = await this.requirePathao(shopId);
    return { places: await this.pathao.cities(config) };
  }

  @Get('pathao/zones')
  @RequirePerm('orders.manage')
  @ApiOperation({ summary: 'Admin: Pathao zones of a city (booking modal)' })
  async pathaoZones(
    @Param('shopId') shopId: string,
    @Query() query: PathaoZonesQuery,
  ) {
    const config = await this.requirePathao(shopId);
    return { places: await this.pathao.zones(config, query.cityId) };
  }

  @Get('pathao/areas')
  @RequirePerm('orders.manage')
  @ApiOperation({ summary: 'Admin: Pathao areas of a zone (booking modal)' })
  async pathaoAreas(
    @Param('shopId') shopId: string,
    @Query() query: PathaoAreasQuery,
  ) {
    const config = await this.requirePathao(shopId);
    return { places: await this.pathao.areas(config, query.zoneId) };
  }

  private async requirePathao(shopId: string) {
    const config = await this.settings.pathaoConfig(shopId);
    if (!config) {
      throw new BadRequestException(
        'Save your Pathao credentials in Settings first.',
      );
    }
    return config;
  }
}
