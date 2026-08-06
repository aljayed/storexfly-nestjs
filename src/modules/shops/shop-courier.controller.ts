import {
  BadRequestException,
  Controller,
  Get,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Min, MinLength } from 'class-validator';
import { Public } from '../../common/decorators/public.decorator';
import { RequirePerm } from '../../common/decorators/roles.decorator';
import { AdminJwtAuthGuard } from '../../common/guards/admin-jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ShopScopeGuard } from '../../common/guards/shop-scope.guard';
import { CarrybeeService } from '../gateways/carrybee.service';
import { CourierSettingsService } from '../gateways/courier-settings.service';
import { PathaoService } from '../gateways/pathao.service';

class ZonesQuery {
  @Type(() => Number) @IsInt() @Min(1) cityId!: number;
}

class AreasQuery {
  @Type(() => Number) @IsInt() @Min(1) cityId!: number;
  @Type(() => Number) @IsInt() @Min(1) zoneId!: number;
}

class SuggestQuery {
  @IsString() @MinLength(3) search!: string;
}

class PathaoAreasQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) zoneId!: number;
}

/**
 * Seller console: read-only courier lookups for the order booking modal.
 *
 * There is deliberately no credential screen here any more. Parcels are booked
 * on the platform's own courier account (see PlatformCouriersController) - a
 * shop on its own account could keep an entire fulfilment, and so the sales it
 * is billed on, off the platform's books. All a seller needs is the name of
 * the courier and the place ids for the address.
 */
@ApiTags('shops')
@Public()
@UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
@ApiBearerAuth()
@Controller('shops/:shopId/courier')
export class ShopCourierController {
  constructor(
    private readonly settings: CourierSettingsService,
    private readonly carrybee: CarrybeeService,
    private readonly pathao: PathaoService,
  ) {}

  @Get('active')
  @RequirePerm('orders.manage')
  @ApiOperation({
    summary:
      'Admin: which courier bookings go through, and whether it is mandatory',
  })
  async active() {
    const [active, required] = await Promise.all([
      this.settings.activeCourier(),
      this.settings.courierRequired(),
    ]);
    return { provider: active?.provider ?? null, required };
  }

  @Get('cities')
  @RequirePerm('orders.manage')
  @ApiOperation({ summary: 'Admin: courier city list (booking modal)' })
  async cities() {
    const active = await this.requireActive();
    if (active.provider === 'carrybee') {
      return { places: await this.carrybee.cities(active.config) };
    }
    if (active.provider === 'pathao') {
      return { places: await this.pathao.cities(active.config) };
    }
    // Steadfast routes on the written address alone.
    return { places: [] };
  }

  @Get('zones')
  @RequirePerm('orders.manage')
  @ApiOperation({ summary: 'Admin: courier zones of a city (booking modal)' })
  async zones(@Query() query: ZonesQuery) {
    const active = await this.requireActive();
    if (active.provider === 'carrybee') {
      return { places: await this.carrybee.zones(active.config, query.cityId) };
    }
    if (active.provider === 'pathao') {
      return { places: await this.pathao.zones(active.config, query.cityId) };
    }
    return { places: [] };
  }

  @Get('areas')
  @RequirePerm('orders.manage')
  @ApiOperation({ summary: 'Admin: courier areas of a zone (booking modal)' })
  async areas(@Query() query: AreasQuery) {
    const active = await this.requireActive();
    if (active.provider === 'carrybee') {
      return {
        places: await this.carrybee.areas(
          active.config,
          query.cityId,
          query.zoneId,
        ),
      };
    }
    if (active.provider === 'pathao') {
      return { places: await this.pathao.areas(active.config, query.zoneId) };
    }
    return { places: [] };
  }

  @Get('suggest')
  @RequirePerm('orders.manage')
  @ApiOperation({
    summary: 'Admin: CarryBee area search - type-ahead for the booking modal',
  })
  async suggest(@Query() query: SuggestQuery) {
    const active = await this.requireActive();
    if (active.provider !== 'carrybee') return { items: [] };
    return {
      items: await this.carrybee.suggestAreas(active.config, query.search),
    };
  }

  /** Pathao's area list is keyed by zone alone; kept separate so the modal
   *  can call it without inventing a city id. */
  @Get('pathao-areas')
  @RequirePerm('orders.manage')
  @ApiOperation({ summary: 'Admin: Pathao areas of a zone (booking modal)' })
  async pathaoAreas(@Query() query: PathaoAreasQuery) {
    const active = await this.requireActive();
    if (active.provider !== 'pathao') return { places: [] };
    return { places: await this.pathao.areas(active.config, query.zoneId) };
  }

  private async requireActive() {
    const active = await this.settings.activeCourier();
    if (!active) {
      throw new BadRequestException(
        'No courier is set up on the platform yet.',
      );
    }
    return active;
  }
}
