import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Period selector for the platform settlements view. */
export class PlatformSettlementsQueryDto {
  @ApiPropertyOptional({
    example: '2026-06',
    description: 'Earnings month (default: last completed month)',
  })
  @IsOptional()
  @Matches(PERIOD_PATTERN, { message: 'period must be "YYYY-MM"' })
  period?: string;
}

/** Mark (or un-mark) one shop-month payout as paid. */
export class SettlementDecisionDto {
  @ApiProperty({ description: 'true = record the payout, false = undo it' })
  @IsBoolean()
  paid!: boolean;

  @ApiPropertyOptional({
    description: 'Payment reference (bank transfer id, bKash trx id, …)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}

export { PERIOD_PATTERN };
