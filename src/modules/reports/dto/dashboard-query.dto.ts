import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsOptional } from 'class-validator';

/**
 * Optional reporting window for the dashboard. Date-only bounds (e.g.
 * "2026-05-01") are inclusive calendar dates; bounds with a time part
 * (e.g. "2026-05-01T14:00:00Z", used for "last 24 hours") are exact
 * instants with `to` exclusive. Defaults to the last 12 months.
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
