import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  MAX_TRUST_BADGES,
  TRUST_BADGE_ICONS,
  TRUST_BADGE_SUBTITLE_MAX,
  TRUST_BADGE_TITLE_MAX,
  type TrustBadgeIcon,
} from '../../../common/constants/trust-badges';
import type { BrandSwatchId } from '../../../common/constants/brand-swatches';
import {
  SUPPORTED_CURRENCIES,
  type CurrencyCode,
} from '../../../common/constants/currencies';
import {
  brandSwatchEnum,
  shopCategoryEnum,
  shopLanguageEnum,
} from '../../../database/schema/enums';

type ShopCategory = (typeof shopCategoryEnum.enumValues)[number];
type ShopLanguage = (typeof shopLanguageEnum.enumValues)[number];

/** One product-page "why buy" badge (packed fresh, fast delivery, …). */
export class TrustBadgeDto {
  @ApiProperty({ enum: TRUST_BADGE_ICONS, example: 'truck' })
  @IsIn(TRUST_BADGE_ICONS)
  icon!: TrustBadgeIcon;

  @ApiProperty({ example: 'Fast delivery' })
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MinLength(1)
  @MaxLength(TRUST_BADGE_TITLE_MAX)
  title!: string;

  @ApiProperty({ example: '1-2 days inside Dhaka' })
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MaxLength(TRUST_BADGE_SUBTITLE_MAX)
  subtitle!: string;

  @ApiProperty({ example: true })
  @IsBoolean()
  enabled!: boolean;
}

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
  @MaxLength(254)
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

  // Default storefront language for buyers landing on this shop. Buyers can
  // still switch via the storefront's own language toggle.
  @ApiPropertyOptional({ enum: shopLanguageEnum.enumValues, example: 'en' })
  @IsOptional()
  @IsEnum(shopLanguageEnum.enumValues)
  language?: ShopLanguage;

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
    description:
      'Storefront floating hero images (data URLs). Replaces the set.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4)
  @IsString({ each: true })
  @MaxLength(3_000_000, { each: true })
  floatingImages?: string[];

  // Product-page trust badges. Replace-all: an empty array clears them (the
  // storefront then hides the strip entirely); omit to leave unchanged.
  @ApiPropertyOptional({
    type: [TrustBadgeDto],
    description: 'Product-page "why buy" badges. Replaces the full set.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_TRUST_BADGES)
  @ValidateNested({ each: true })
  @Type(() => TrustBadgeDto)
  trustBadges?: TrustBadgeDto[];
}
