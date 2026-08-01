import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiProperty,
  ApiPropertyOptional,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { Public } from '../../common/decorators/public.decorator';
import { PlatformJwtAuthGuard } from '../../common/guards/platform-jwt-auth.guard';
import {
  BillingSettingsService,
  MAX_MONTHLY_FEE_CENTS,
  MAX_SALES_CAP_CENTS,
  MIN_MONTHLY_FEE_CENTS,
  MIN_SALES_CAP_CENTS,
} from '../billing/billing-settings.service';

export class UpdatePlanDto {
  @ApiPropertyOptional({ example: 'Growth' })
  @IsOptional()
  @IsString()
  @Length(1, 60)
  name?: string;

  @ApiPropertyOptional({
    example: 119900,
    description: 'Monthly price in paisa (৳1,199.00 = 119900)',
    minimum: MIN_MONTHLY_FEE_CENTS,
    maximum: MAX_MONTHLY_FEE_CENTS,
  })
  @IsOptional()
  @IsInt()
  @Min(MIN_MONTHLY_FEE_CENTS)
  @Max(MAX_MONTHLY_FEE_CENTS)
  priceCents?: number;

  @ApiPropertyOptional({
    example: 25000000,
    nullable: true,
    description:
      'Monthly sales ceiling in paisa; null makes the plan uncapped (the top rung)',
    minimum: MIN_SALES_CAP_CENTS,
    maximum: MAX_SALES_CAP_CENTS,
  })
  @IsOptional()
  // null is meaningful here — it is how a rung is made uncapped.
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(MIN_SALES_CAP_CENTS)
  @Max(MAX_SALES_CAP_CENTS)
  salesCapCents?: number | null;

  @ApiPropertyOptional({
    description: 'A retired plan stays on the shops using it but is not sold',
  })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class UpdatePricingDto {
  @ApiProperty({
    example: 59900,
    description: 'Entry-plan monthly fee in paisa (৳599.00 = 59900)',
    minimum: MIN_MONTHLY_FEE_CENTS,
    maximum: MAX_MONTHLY_FEE_CENTS,
  })
  @IsInt()
  @Min(MIN_MONTHLY_FEE_CENTS)
  @Max(MAX_MONTHLY_FEE_CENTS)
  monthlyFeeCents!: number;
}

/**
 * Operator console: the plan ladder sellers subscribe to. Re-pricing a rung
 * re-prices every live subscription sitting on it, so the platform never runs
 * two prices for the same plan.
 */
@ApiTags('platform-admin')
@Public()
@UseGuards(PlatformJwtAuthGuard)
@ApiBearerAuth()
@Controller('platform/billing')
export class PlatformBillingController {
  constructor(private readonly billing: BillingSettingsService) {}

  @Get()
  @ApiOperation({
    summary: 'Platform: the entry price and every plan (retired ones included)',
  })
  async pricing() {
    const [pricing, all] = await Promise.all([
      this.billing.pricing(),
      this.billing.allPlans(),
    ]);
    return { ...pricing, plans: all };
  }

  @Patch('plans/:id')
  @ApiOperation({
    summary: 'Platform: re-price or re-cap one plan (re-prices its shops)',
  })
  updatePlan(@Param('id') id: string, @Body() dto: UpdatePlanDto) {
    return this.billing.updatePlan(id, dto);
  }

  @Patch()
  @ApiOperation({
    summary: 'Platform: set the entry plan price (kept for older clients)',
  })
  async update(@Body() dto: UpdatePricingDto) {
    const entry = await this.billing.entryPlan();
    await this.billing.updatePlan(entry.id, {
      priceCents: dto.monthlyFeeCents,
    });
    return this.billing.pricing();
  }
}
