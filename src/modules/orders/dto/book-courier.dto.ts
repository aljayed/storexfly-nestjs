import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';

/**
 * Booking options, as the active courier's own place ids.
 *
 * Steadfast needs nothing extra - it routes on the written address. Pathao
 * requires city and zone. CarryBee accepts them too but usually derives them
 * from the address itself, so the booking modal only asks when that fails.
 */
export class BookCourierDto {
  @ApiPropertyOptional({
    description: 'Courier city id (required for Pathao; optional for CarryBee)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  cityId?: number;

  @ApiPropertyOptional({
    description: 'Courier zone id (required for Pathao; optional for CarryBee)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  zoneId?: number;

  @ApiPropertyOptional({ description: 'Courier area id (optional)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  areaId?: number;
}
