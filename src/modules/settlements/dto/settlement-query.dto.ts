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

  @ApiPropertyOptional({
    description:
      'Receipt for the transfer as a data URL (image or PDF). Required ' +
      'when recording a payout - the seller is shown it as the proof they ' +
      'were paid.',
    example: 'data:application/pdf;base64,…',
  })
  @IsOptional()
  @IsString()
  // Strict shape check: this string is later rendered in two consoles, so
  // only base64 image/PDF data URLs are ever accepted - never markup or
  // another URL scheme.
  @Matches(
    /^data:(image\/(png|jpeg|jpg|webp)|application\/pdf);base64,[A-Za-z0-9+/]+=*$/,
    { message: 'proof must be a base64 image or PDF data URL' },
  )
  // ~3 MiB of file. A receipt is a screenshot or a one-page invoice, and
  // these live inline in the row rather than in object storage.
  @MaxLength(4_000_000)
  proof?: string;

  @ApiPropertyOptional({
    description: 'Original filename of the receipt, shown to the seller',
    example: 'bkash-sept-payout.pdf',
  })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  proofName?: string;
}

export { PERIOD_PATTERN };
