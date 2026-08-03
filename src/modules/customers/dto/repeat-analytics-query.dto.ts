import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional } from 'class-validator';

export const REPEAT_WINDOWS = [7, 30, 180, 365] as const;

export class RepeatAnalyticsQueryDto {
  @ApiPropertyOptional({ enum: REPEAT_WINDOWS, default: 30 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn(REPEAT_WINDOWS)
  days = 30;
}
