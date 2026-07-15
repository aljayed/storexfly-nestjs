import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, Max, Min, IsOptional } from 'class-validator';
import { CustomerQueryDto } from './customer-query.dto';

export const ACTIVITY_SORTS = ['orders', 'spent', 'recent'] as const;
export type ActivitySort = (typeof ACTIVITY_SORTS)[number];

/** Query for the month-wise customer activity matrix. */
export class MonthlyActivityQueryDto extends CustomerQueryDto {
  @ApiPropertyOptional({ minimum: 3, maximum: 24, default: 12 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(3)
  @Max(24)
  months = 12;

  @ApiPropertyOptional({ enum: ACTIVITY_SORTS, default: 'orders' })
  @IsOptional()
  @IsIn(ACTIVITY_SORTS)
  sort: ActivitySort = 'orders';
}
