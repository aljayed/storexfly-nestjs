import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
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
  MAX_COMMISSION_BPS,
  MAX_PACK_PRICE_CENTS,
  MAX_SALES_CREDIT_CENTS,
  MIN_COMMISSION_BPS,
  MIN_PACK_PRICE_CENTS,
  MIN_SALES_CREDIT_CENTS,
} from '../billing/billing-settings.service';

export class UpdateCreditPackDto {
  @ApiPropertyOptional({ example: '৳2,00,000 in sales' })
  @IsOptional()
  @IsString()
  @Length(1, 60)
  name?: string;

  @ApiPropertyOptional({
    example: 349900,
    description: 'What the pack costs, in paisa (৳3,499.00 = 349900)',
    minimum: MIN_PACK_PRICE_CENTS,
    maximum: MAX_PACK_PRICE_CENTS,
  })
  @IsOptional()
  @IsInt()
  @Min(MIN_PACK_PRICE_CENTS)
  @Max(MAX_PACK_PRICE_CENTS)
  priceCents?: number;

  @ApiPropertyOptional({
    example: 20000000,
    description:
      'How much selling the pack pays for, in paisa (৳2,00,000.00 = 20000000)',
    minimum: MIN_SALES_CREDIT_CENTS,
    maximum: MAX_SALES_CREDIT_CENTS,
  })
  @IsOptional()
  @IsInt()
  @Min(MIN_SALES_CREDIT_CENTS)
  @Max(MAX_SALES_CREDIT_CENTS)
  salesCreditCents?: number;

  @ApiPropertyOptional({
    example: 'Most popular',
    nullable: true,
    description: 'Shelf label on the pack card; null clears it',
  })
  @IsOptional()
  // null is meaningful here — it is how a label is removed.
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Length(1, 40)
  badge?: string | null;

  @ApiPropertyOptional({
    description: 'A retired pack stays on past purchases but is not sold',
  })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class UpdateCommissionDto {
  @ApiPropertyOptional({
    example: 150,
    description: "The verified track's rate in basis points (150 = 1.5%)",
    minimum: MIN_COMMISSION_BPS,
    maximum: MAX_COMMISSION_BPS,
  })
  @IsInt()
  @Min(MIN_COMMISSION_BPS)
  @Max(MAX_COMMISSION_BPS)
  commissionBps!: number;
}

/**
 * Operator console: the credit packs sellers buy. Re-pricing a pack only
 * changes what is on the shelf from here on — credit a seller already bought
 * is theirs at the price they paid, and the ledger keeps its own amounts.
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
    summary:
      'Platform: the commission rate, the credit cap and every pack (retired ones included)',
  })
  async pricing() {
    const [pricing, all] = await Promise.all([
      this.billing.pricing(),
      this.billing.allPacks(),
    ]);
    return { ...pricing, packs: all };
  }

  @Patch('packs/:id')
  @ApiOperation({ summary: 'Platform: re-price or retire one credit pack' })
  updatePack(@Param('id') id: string, @Body() dto: UpdateCreditPackDto) {
    return this.billing.updatePack(id, dto);
  }

  @Patch('commission')
  @ApiOperation({
    summary:
      "Platform: set the verified track's rate (re-rates every live post-paid shop)",
  })
  async updateCommission(@Body() dto: UpdateCommissionDto) {
    await this.billing.updateCommissionBps(dto.commissionBps);
    return this.billing.pricing();
  }
}
