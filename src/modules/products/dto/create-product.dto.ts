import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
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
  listingTypeEnum,
  paymentMethodEnum,
  productTagEnum,
} from '../../../database/schema/enums';

type ProductTag = (typeof productTagEnum.enumValues)[number];
type PaymentMethod = (typeof paymentMethodEnum.enumValues)[number];
type ListingType = (typeof listingTypeEnum.enumValues)[number];

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

/** One choice inside a variant group; `priceDelta` adjusts the base price. */
export class VariantOptionDto {
  @ApiPropertyOptional({
    description: 'Stable id — assigned by the API when absent.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(24)
  id?: string;

  @ApiProperty({ example: 'Large' })
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  label!: string;

  @ApiPropertyOptional({
    example: 50,
    description: 'Price adjustment vs the base price (can be negative).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(-1_000_000)
  @Max(1_000_000)
  priceDelta?: number;
}

/** A buyer-facing option group (e.g. "Size" with S / M / L). */
export class VariantGroupDto {
  @ApiPropertyOptional({
    description: 'Stable id — assigned by the API when absent.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(24)
  id?: string;

  @ApiProperty({ example: 'Size' })
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  name!: string;

  @ApiProperty({ type: [VariantOptionDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(12)
  @ValidateNested({ each: true })
  @Type(() => VariantOptionDto)
  options!: VariantOptionDto[];
}

/** A multi-buy bundle: `units` units for `price` total. */
export class PackDto {
  @ApiPropertyOptional({
    description: 'Stable id — assigned by the API when absent.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(24)
  id?: string;

  @ApiPropertyOptional({
    example: 'Family pack',
    description: 'Optional label — defaults to "Pack of N" on the storefront.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  label?: string;

  @ApiProperty({ example: 3, minimum: 2 })
  @Type(() => Number)
  @IsInt()
  @Min(2)
  @Max(9999)
  units!: number;

  @ApiProperty({ example: 270, description: 'Total price for the pack.' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  price!: number;
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

  @ApiPropertyOptional({
    enum: listingTypeEnum.enumValues,
    default: 'sale',
    description:
      "'sale' = online checkout; 'showcase' = advertise-only, buyers contact the seller.",
  })
  @IsOptional()
  @IsEnum(listingTypeEnum.enumValues)
  listingType?: ListingType;

  @ApiProperty({ example: 38, description: 'Unit price in dollars' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  price!: number;

  @ApiPropertyOptional({
    example: 45,
    description:
      'Seller-entered "compare at" (regular) price, struck through next to ' +
      'the selling price. 0/absent = no discount display.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  comparePrice?: number;

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
  // Same caps as the shop banner images: at most 8 photos, each ≤ ~2 MB as a
  // base64 data URL, so one product can't balloon into a multi-MB public
  // payload every storefront visitor downloads.
  @ArrayMaxSize(8)
  @IsString({ each: true })
  @MaxLength(3_000_000, { each: true })
  images?: string[];

  @ApiPropertyOptional({ type: [HighlightDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => HighlightDto)
  highlights?: HighlightDto[];

  @ApiPropertyOptional({
    type: [VariantGroupDto],
    description:
      'Buyer-facing option groups (≤ 2). Present-but-empty clears them.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(2)
  @ValidateNested({ each: true })
  @Type(() => VariantGroupDto)
  variantGroups?: VariantGroupDto[];

  @ApiPropertyOptional({
    type: [PackDto],
    description: 'Multi-buy bundles (≤ 8). Present-but-empty clears them.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => PackDto)
  packs?: PackDto[];

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
