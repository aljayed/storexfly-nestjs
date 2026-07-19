import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

/** One member product of a combo — `qty` units of it per combo set. */
export class ComboItemDto {
  @ApiProperty()
  @IsUUID()
  productId!: string;

  @ApiPropertyOptional({ example: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(99)
  qty?: number;
}

export class CreateComboDto {
  @ApiProperty({ example: 'Mango lover duo' })
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  name!: string;

  @ApiPropertyOptional({ example: '🎁' })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  emoji?: string;

  @ApiPropertyOptional({ example: 'Our two bestsellers, together for less.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  blurb?: string;

  @ApiProperty({ example: 999, description: 'Combo price (dollars)' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  price!: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiProperty({ type: [ComboItemDto], description: '2–6 member products' })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(6)
  @ValidateNested({ each: true })
  @Type(() => ComboItemDto)
  items!: ComboItemDto[];
}

/** All create fields optional; `items` present = replace the member list. */
export class UpdateComboDto extends PartialType(CreateComboDto) {}
