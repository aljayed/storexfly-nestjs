import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsOptional } from 'class-validator';

/**
 * Optional reporting window for the dashboard. Both bounds are inclusive
 * calendar dates (ISO, e.g. "2026-05-01"). Defaults to the last 12 months.
 */
export class DashboardQuery {
  @ApiPropertyOptional({ example: '2026-05-01' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ example: '2026-06-11' })
  @IsOptional()
  @IsISO8601()
  to?: string;
}
