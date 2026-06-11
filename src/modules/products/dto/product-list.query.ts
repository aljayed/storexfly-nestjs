import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ProductListQuery {
  @ApiPropertyOptional({
    example: 'Mangoes',
    description: 'Filter by in-shop category. "All" or omitted returns every item.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  cat?: string;
}
