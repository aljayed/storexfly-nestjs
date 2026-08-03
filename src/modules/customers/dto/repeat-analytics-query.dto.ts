import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsOptional } from 'class-validator';

/**
 * Reporting window for the retention report. Uses the same [from, to]
 * contract as every other report on the console (see `DashboardQuery`), so
 * the seller's period picker drives all of them at once. Defaults to the
 * last 30 days when neither bound is given.
 */
export class RepeatAnalyticsQueryDto {
  @ApiPropertyOptional({ example: '2026-05-01' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ example: '2026-05-30' })
  @IsOptional()
  @IsISO8601()
  to?: string;
}
