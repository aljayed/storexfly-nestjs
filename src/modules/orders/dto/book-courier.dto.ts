import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';

/**
 * Booking options. Steadfast needs nothing extra; Pathao requires the
 * recipient's city and zone as Pathao's own numeric IDs (area optional),
 * picked by the seller in the booking modal.
 */
export class BookCourierDto {
  @ApiPropertyOptional({ description: 'Pathao city id (required for Pathao)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  cityId?: number;

  @ApiPropertyOptional({ description: 'Pathao zone id (required for Pathao)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  zoneId?: number;

  @ApiPropertyOptional({ description: 'Pathao area id (optional)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  areaId?: number;
}
