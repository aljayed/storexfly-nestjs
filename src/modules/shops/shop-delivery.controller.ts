import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, Min } from 'class-validator';
import { Public } from '../../common/decorators/public.decorator';
import { ShopDeliveryService } from './shop-delivery.service';

class CityQuery { @Type(() => Number) @IsInt() @Min(1) cityId!: number; }
class ZoneQuery extends CityQuery { @Type(() => Number) @IsInt() @Min(1) zoneId!: number; }

// Public geographic data lets onboarding use the same picker before a shop exists.
// No merchant credentials, pickup stores or seller details are returned here.
@Public()
@ApiTags('shops')
@Controller('shop-delivery')
export class ShopDeliveryController {
  constructor(private readonly delivery: ShopDeliveryService) {}
  @Get('options') options() { return this.delivery.options(); }
  @Get('cities') cities() { return this.delivery.cities(); }
  @Get('zones') zones(@Query() query: CityQuery) { return this.delivery.zones(query.cityId); }
  @Get('areas') areas(@Query() query: ZoneQuery) { return this.delivery.areas(query.cityId, query.zoneId); }
}
