import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { PlatformJwtAuthGuard } from '../../common/guards/platform-jwt-auth.guard';
import { CouponsService } from '../coupons/coupons.service';
import { CouponResponse } from '../coupons/dto/coupon.response';
import {
  CreateCouponDto,
  UpdateCouponDto,
} from '../coupons/dto/create-coupon.dto';

/** Coupon management from the platform-admin console. */
@ApiTags('platform-admin')
@Public()
@UseGuards(PlatformJwtAuthGuard)
@ApiBearerAuth()
@Controller('platform/coupons')
export class PlatformCouponsController {
  constructor(private readonly coupons: CouponsService) {}

  @Get()
  @ApiOperation({ summary: 'Platform admin: list all coupons' })
  @ApiOkResponse({ type: [CouponResponse] })
  list() {
    return this.coupons.list();
  }

  @Post()
  @ApiOperation({ summary: 'Platform admin: create a coupon' })
  @ApiOkResponse({ type: CouponResponse })
  create(@Body() dto: CreateCouponDto) {
    return this.coupons.create(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Platform admin: activate/deactivate a coupon' })
  @ApiOkResponse({ type: CouponResponse })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCouponDto) {
    return this.coupons.setActive(id, dto.active ?? true);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Platform admin: delete a coupon' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.coupons.remove(id);
  }
}
