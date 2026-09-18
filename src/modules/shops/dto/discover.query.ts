import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class DiscoverQuery {
  @ApiPropertyOptional({ description: 'Search products, categories and shop names' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  q?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  category?: string;

  @ApiPropertyOptional({ enum: ['all', 'stock', 'showcase'], default: 'all' })
  @IsIn(['all', 'stock', 'showcase'])
  availability: 'all' | 'stock' | 'showcase' = 'all';

  @ApiPropertyOptional({ enum: ['newest', 'rating'], default: 'newest' })
  @IsIn(['newest', 'rating'])
  sort: 'newest' | 'rating' = 'newest';

  @ApiPropertyOptional({ default: 1, minimum: 1, maximum: 1000 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  page = 1;

  @ApiPropertyOptional({ default: 24, minimum: 1, maximum: 48 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(48)
  limit = 24;
}
