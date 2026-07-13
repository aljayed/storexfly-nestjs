import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { IsNumber, Max, Min } from 'class-validator';
import { Public } from '../../common/decorators/public.decorator';
import { PlatformJwtAuthGuard } from '../../common/guards/platform-jwt-auth.guard';
import { FeesService } from './fees.service';

/** Current gateway fee rates as percentages. */
export class FeePercentsResponse {
  @ApiProperty({
    example: 3,
    description: 'Mobile-banking maintenance charge %',
  })
  mbank!: number;
  @ApiProperty({
    example: 4.5,
    description: 'SSLCommerz card-processing fee %',
  })
  card!: number;
}

export class UpdateFeesDto {
  @ApiProperty({ example: 3 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(25)
  mbank!: number;

  @ApiProperty({ example: 4.5 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(25)
  card!: number;
}

/**
 * The rates are quoted to sellers all over the console (item form, settlement
 * pages), so reading them is public like branding; changing them is operator
 * only. Fee changes apply to all *pending* settlement math immediately —
 * already-paid months keep their snapshotted rates.
 */
@ApiTags('platform-admin')
@Controller('platform/fees')
export class FeesController {
  constructor(private readonly fees: FeesService) {}

  @Get()
  @Public()
  @ApiOperation({ summary: 'Current payment-gateway fee percentages' })
  @ApiOkResponse({ type: FeePercentsResponse })
  get() {
    return this.fees.getPercents();
  }

  @Patch()
  @Public()
  @UseGuards(PlatformJwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Platform admin: update the fee percentages' })
  @ApiOkResponse({ type: FeePercentsResponse })
  update(@Body() dto: UpdateFeesDto) {
    return this.fees.updatePercents(dto.mbank, dto.card);
  }
}
