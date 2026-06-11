import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  paymentMethodEnum,
  productTagEnum,
} from '../../../database/schema/enums';

type ProductTag = (typeof productTagEnum.enumValues)[number];
type PaymentMethod = (typeof paymentMethodEnum.enumValues)[number];

/** One seller-authored selling point (the product-page "trust" badges). */
export class HighlightDto {
  @ApiPropertyOptional({
    example: 'truck',
    description: 'Icon key from the storefront icon set.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  icon?: string;

  @ApiProperty({ example: 'Free next-day' })
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  title!: string;

  @ApiPropertyOptional({ example: 'Cold-chain delivery' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  subtitle?: string;
}

export class CreateProductDto {
  @ApiProperty({ example: 'Alphonso Mango Box' })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name!: string;

  @ApiProperty({ example: 'Mangoes' })
  @IsString()
  @MaxLength(80)
  cat!: string;

  @ApiProperty({ example: 38, description: 'Unit price in dollars' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  price!: number;

  @ApiProperty({ example: 'box of 12' })
  @IsString()
  @MaxLength(60)
  unit!: string;

  @ApiPropertyOptional({ example: 46, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  stock?: number;

  @ApiPropertyOptional({
    example: 70,
    description: 'Delivery charge inside Dhaka (0 = free). Default 70.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  deliveryDhaka?: number;

  @ApiPropertyOptional({
    example: 120,
    description: 'Delivery charge outside Dhaka (0 = free). Default 120.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  deliveryOutside?: number;

  @ApiPropertyOptional({ example: '🥭' })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  emoji?: string;

  @ApiPropertyOptional({ example: '#fbeede' })
  @IsOptional()
  @IsString()
  @Matches(/^#?[0-9a-fA-F]{3,8}$/)
  tone?: string;

  @ApiPropertyOptional({ enum: productTagEnum.enumValues })
  @IsOptional()
  @IsEnum(productTagEnum.enumValues)
  tag?: ProductTag;

  @ApiPropertyOptional({
    enum: paymentMethodEnum.enumValues,
    isArray: true,
    description: 'Payment methods buyers may use. At least one required.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsEnum(paymentMethodEnum.enumValues, { each: true })
  paymentMethods?: PaymentMethod[];

  @ApiPropertyOptional({ example: 0, minimum: 0, maximum: 5 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(5)
  rating?: number;

  @ApiPropertyOptional({ example: 'The king of mangoes…' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  blurb?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  images?: string[];

  @ApiPropertyOptional({ type: [HighlightDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => HighlightDto)
  highlights?: HighlightDto[];

  @ApiPropertyOptional({
    example: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    description: 'Optional product video — a YouTube URL.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  // An empty string clears the video; only validate the pattern when one is set.
  @ValidateIf((o: CreateProductDto) => !!o.videoUrl)
  @Matches(
    /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|embed\/|shorts\/)|youtu\.be\/)[\w-]{11}/,
    { message: 'videoUrl must be a valid YouTube link' },
  )
  videoUrl?: string;
}
