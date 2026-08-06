import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
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
  MinLength,
} from 'class-validator';
import { Public } from '../../common/decorators/public.decorator';
import { PlatformJwtAuthGuard } from '../../common/guards/platform-jwt-auth.guard';
import { CarrybeeService } from '../gateways/carrybee.service';
import { CourierSettingsService } from '../gateways/courier-settings.service';
import { PathaoService } from '../gateways/pathao.service';

const WRITE_ONLY = 'Write-only; omit to keep the stored value';

export class UpdateCarrybeeSettingsDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() enabled?: boolean;
  @ApiPropertyOptional({ description: 'true = CarryBee sandbox environment' })
  @IsOptional()
  @IsBoolean()
  sandbox?: boolean;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  clientId?: string;
  @ApiPropertyOptional({ description: WRITE_ONLY })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  clientSecret?: string;
  @ApiPropertyOptional({ description: WRITE_ONLY })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  clientContext?: string;
  @ApiPropertyOptional({
    description: 'Pickup store parcels are collected from',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  storeId?: string;
  @ApiPropertyOptional({
    description: `${WRITE_ONLY}. Secret CarryBee echoes on its webhook`,
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  webhookSecret?: string;
}

export class UpdatePlatformSteadfastDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() enabled?: boolean;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  apiKey?: string;
  @ApiPropertyOptional({ description: WRITE_ONLY })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  secretKey?: string;
}

export class UpdatePlatformPathaoDto {
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
  @ApiPropertyOptional({ description: WRITE_ONLY })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  clientSecret?: string;
  @ApiPropertyOptional({ description: 'Pathao merchant account email' })
  @IsOptional()
  @IsString()
  @MaxLength(254)
  username?: string;
  @ApiPropertyOptional({ description: WRITE_ONLY })
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

export class SetCourierRequiredDto {
  @ApiProperty({
    description: 'true = shops may only ship through the platform courier',
  })
  @IsBoolean()
  required!: boolean;
}

export class CreateCarrybeeStoreDto {
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(30) name!: string;
  @ApiProperty()
  @IsString()
  @MinLength(3)
  @MaxLength(30)
  contactPersonName!: string;
  @ApiProperty()
  @IsString()
  @MaxLength(20)
  contactPersonNumber!: string;
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(100) address!: string;
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) cityId!: number;
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) zoneId!: number;
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) areaId!: number;
}

class ZonesQuery {
  @Type(() => Number) @IsInt() @Min(1) cityId!: number;
}

class AreasQuery {
  @Type(() => Number) @IsInt() @Min(1) cityId!: number;
  @Type(() => Number) @IsInt() @Min(1) zoneId!: number;
}

class PathaoZonesQuery {
  @Type(() => Number) @IsInt() @Min(1) cityId!: number;
}

class PathaoAreasQuery {
  @Type(() => Number) @IsInt() @Min(1) zoneId!: number;
}

/**
 * Operator console: the platform's own courier merchant credentials. Secrets
 * are write-only - reads only reveal whether one is stored.
 *
 * Sellers have no equivalent screen. Couriers are deliberately not per-shop:
 * a shop booking parcels on its own account owns the whole fulfilment record
 * and can keep the sales it is billed on off the platform's books entirely.
 */
@ApiTags('platform-admin')
@Public()
@UseGuards(PlatformJwtAuthGuard)
@ApiBearerAuth()
@Controller('platform/couriers')
export class PlatformCouriersController {
  constructor(
    private readonly settings: CourierSettingsService,
    private readonly carrybee: CarrybeeService,
    private readonly pathao: PathaoService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Platform: courier settings (secrets masked)' })
  view() {
    return this.settings.view();
  }

  @Patch('carrybee')
  @ApiOperation({ summary: 'Platform: update CarryBee credentials' })
  updateCarrybee(@Body() dto: UpdateCarrybeeSettingsDto) {
    return this.settings.updateCarrybee(dto);
  }

  @Patch('steadfast')
  @ApiOperation({ summary: 'Platform: update Steadfast credentials' })
  updateSteadfast(@Body() dto: UpdatePlatformSteadfastDto) {
    return this.settings.updateSteadfast(dto);
  }

  @Patch('pathao')
  @ApiOperation({ summary: 'Platform: update Pathao credentials' })
  updatePathao(@Body() dto: UpdatePlatformPathaoDto) {
    return this.settings.updatePathao(dto);
  }

  @Patch('required')
  @ApiOperation({
    summary:
      'Platform: confine shops to the platform courier (or release them)',
  })
  setRequired(@Body() dto: SetCourierRequiredDto) {
    return this.settings.setCourierRequired(dto.required);
  }

  // ── CarryBee account lookups ────────────────────────────────────

  @Post('carrybee/verify')
  @ApiOperation({ summary: 'Platform: check the saved CarryBee credentials' })
  async verifyCarrybee() {
    await this.carrybee.verify(await this.requireCarrybee());
    return { ok: true };
  }

  @Get('carrybee/stores')
  @ApiOperation({ summary: 'Platform: CarryBee pickup stores (store picker)' })
  async carrybeeStores() {
    const config = await this.requireCarrybee();
    return { stores: await this.carrybee.stores(config) };
  }

  @Post('carrybee/stores')
  @ApiOperation({ summary: 'Platform: register a CarryBee pickup store' })
  async createCarrybeeStore(@Body() dto: CreateCarrybeeStoreDto) {
    const config = await this.requireCarrybee();
    await this.carrybee.createStore(config, dto);
    // CarryBee returns no body on create, so hand back the refreshed list -
    // the console picks the new store out of it.
    return { stores: await this.carrybee.stores(config) };
  }

  @Get('carrybee/cities')
  @ApiOperation({ summary: 'Platform: CarryBee city list' })
  async carrybeeCities() {
    return { places: await this.carrybee.cities(await this.requireCarrybee()) };
  }

  @Get('carrybee/zones')
  @ApiOperation({ summary: 'Platform: CarryBee zones of a city' })
  async carrybeeZones(@Query() query: ZonesQuery) {
    const config = await this.requireCarrybee();
    return { places: await this.carrybee.zones(config, query.cityId) };
  }

  @Get('carrybee/areas')
  @ApiOperation({ summary: 'Platform: CarryBee areas of a zone' })
  async carrybeeAreas(@Query() query: AreasQuery) {
    const config = await this.requireCarrybee();
    return {
      places: await this.carrybee.areas(config, query.cityId, query.zoneId),
    };
  }

  // ── Pathao account lookups ──────────────────────────────────────

  @Get('pathao/stores')
  @ApiOperation({ summary: 'Platform: Pathao stores (store picker)' })
  async pathaoStores() {
    return { stores: await this.pathao.stores(await this.requirePathao()) };
  }

  @Get('pathao/cities')
  @ApiOperation({ summary: 'Platform: Pathao city list' })
  async pathaoCities() {
    return { places: await this.pathao.cities(await this.requirePathao()) };
  }

  @Get('pathao/zones')
  @ApiOperation({ summary: 'Platform: Pathao zones of a city' })
  async pathaoZones(@Query() query: PathaoZonesQuery) {
    const config = await this.requirePathao();
    return { places: await this.pathao.zones(config, query.cityId) };
  }

  @Get('pathao/areas')
  @ApiOperation({ summary: 'Platform: Pathao areas of a zone' })
  async pathaoAreas(@Query() query: PathaoAreasQuery) {
    const config = await this.requirePathao();
    return { places: await this.pathao.areas(config, query.zoneId) };
  }

  private async requireCarrybee() {
    const config = await this.settings.carrybeeConfig();
    if (!config) {
      throw new BadRequestException(
        'Save the CarryBee client ID, secret and context first.',
      );
    }
    return config;
  }

  private async requirePathao() {
    const config = await this.settings.pathaoConfig();
    if (!config) {
      throw new BadRequestException('Save the Pathao credentials first.');
    }
    return config;
  }
}
