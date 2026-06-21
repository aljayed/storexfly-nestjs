import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import type { BrandSwatchId } from '../../../common/constants/brand-swatches';
import {
  SUPPORTED_CURRENCIES,
  type CurrencyCode,
} from '../../../common/constants/currencies';
import {
  brandSwatchEnum,
  shopCategoryEnum,
} from '../../../database/schema/enums';

type ShopCategory = (typeof shopCategoryEnum.enumValues)[number];

/** Patch a shop's brand color, tagline, name or category (owner only). */
export class UpdateShopDto {
  @ApiPropertyOptional({ example: 'Mango Shop' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  name?: string;

  @ApiPropertyOptional({ example: 'Tropical fruit, delivered fresh.' })
  @IsOptional()
  @IsString()
  @MaxLength(240)
  tagline?: string;

  // Buyer-facing support email. Empty string clears it; otherwise must be valid.
  @ApiPropertyOptional({ example: 'help@mango-shop.com' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @ValidateIf((o: UpdateShopDto) => !!o.supportEmail)
  @IsEmail()
  @MaxLength(320)
  supportEmail?: string;

  // Buyer-facing support phone (free-form so sellers can format as they like).
  @ApiPropertyOptional({ example: '+8801712345678' })
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MaxLength(24)
  supportPhone?: string;

  @ApiPropertyOptional({ enum: shopCategoryEnum.enumValues })
  @IsOptional()
  @IsEnum(shopCategoryEnum.enumValues)
  cat?: ShopCategory;

  @ApiPropertyOptional({ enum: SUPPORTED_CURRENCIES, example: 'BDT' })
  @IsOptional()
  @IsIn(SUPPORTED_CURRENCIES)
  currency?: CurrencyCode;

  @ApiPropertyOptional({ enum: brandSwatchEnum.enumValues })
  @IsOptional()
  @IsEnum(brandSwatchEnum.enumValues)
  brandId?: BrandSwatchId;

  // Storefront hero banner images as data URLs (or hosted URLs). Replaces the
  // whole set; an empty array clears all banners. Capped to keep the row small.
  @ApiPropertyOptional({
    type: [String],
    description: 'Storefront banner images (data URLs). Replaces the full set.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @IsString({ each: true })
  // ~2 MB image → ~2.8 MB base64 data URL; caps total payload under the 15 MB
  // body limit even when all banners are re-sent on a replace-all save.
  @MaxLength(3_000_000, { each: true })
  bannerImages?: string[];

  // Decorative images floating over the hero. Same replace-all + size rules.
  @ApiPropertyOptional({
    type: [String],
    description: 'Storefront floating hero images (data URLs). Replaces the set.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4)
  @IsString({ each: true })
  @MaxLength(3_000_000, { each: true })
  floatingImages?: string[];
}
