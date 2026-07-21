import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiProperty,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';
import { Public } from '../../common/decorators/public.decorator';
import { PlatformJwtAuthGuard } from '../../common/guards/platform-jwt-auth.guard';
import {
  BillingSettingsService,
  MAX_MONTHLY_FEE_CENTS,
  MIN_MONTHLY_FEE_CENTS,
} from '../billing/billing-settings.service';

export class UpdatePricingDto {
  @ApiProperty({
    example: 59900,
    description: 'Monthly per-shop fee in paisa (৳599.00 = 59900)',
    minimum: MIN_MONTHLY_FEE_CENTS,
    maximum: MAX_MONTHLY_FEE_CENTS,
  })
  @IsInt()
  @Min(MIN_MONTHLY_FEE_CENTS)
  @Max(MAX_MONTHLY_FEE_CENTS)
  monthlyFeeCents!: number;
}

/**
 * Operator console: the platform's monthly per-shop price. Saving re-prices
 * every live subscription, so the whole platform stays on one plan.
 */
@ApiTags('platform-admin')
@Public()
@UseGuards(PlatformJwtAuthGuard)
@ApiBearerAuth()
@Controller('platform/billing')
export class PlatformBillingController {
  constructor(private readonly billing: BillingSettingsService) {}

  @Get()
  @ApiOperation({ summary: 'Platform: the current monthly subscription price' })
  pricing() {
    return this.billing.pricing();
  }

  @Patch()
  @ApiOperation({
    summary: 'Platform: set the monthly price (re-prices live subscriptions)',
  })
  update(@Body() dto: UpdatePricingDto) {
    return this.billing.update(dto.monthlyFeeCents);
  }
}
