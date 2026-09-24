import { DeliverySettingsDto } from './delivery-settings.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
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
  MAX_DELIVERY_DAYS,
  MIN_DELIVERY_DAYS,
} from '../../../common/constants/delivery';
import {
  brandSwatchEnum,
  paymentMethodEnum,
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
export class UpdateShopDto extends DeliverySettingsDto {
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

  // AI auto-reply in the inbox. When on, a customer message gets an answer
  // drawn from this shop's own catalog while the seller is away; the agent
  // hands the thread back to a human when it escalates.
  @ApiPropertyOptional({
    description: 'Auto-reply to inbox messages with the AI assistant',
  })
  @IsOptional()
  @IsBoolean()
  botChatEnabled?: boolean;

  @ApiPropertyOptional({
    enum: paymentMethodEnum.enumValues,
    isArray: true,
    description: 'Payment methods offered across every item in this shop',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @IsEnum(paymentMethodEnum.enumValues, { each: true })
  paymentMethods?: (typeof paymentMethodEnum.enumValues)[number][];

  @ApiPropertyOptional({
    description: 'Require a 15% online advance for Cash on Delivery orders',
  })
  @IsOptional()
  @IsBoolean()
  codAdvanceEnabled?: boolean;

  // Takes orders from signed-in customers only. A throwaway Cash-on-Delivery
  // order costs the seller a dispatched parcel; an account is something that
  // can be warned and blocked, and one whose proved phone number carries from
  // one order to the next.
  @ApiPropertyOptional({
    description: 'Accept orders only from buyers who are signed in',
  })
  @IsOptional()
  @IsBoolean()
  requireBuyerLogin?: boolean;

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

  /*
   * How long this shop takes to deliver, in days from the order being placed.
   * Buyer-facing and required by the payment gateway, which is why it is here
   * rather than on DeliverySettingsDto with the courier pickup address: that
   * one is shared with onboarding, where nobody is asked this yet, and a new
   * shop simply starts on the platform window.
   *
   * Every product in the shop quotes these unless it carries its own
   * override, so changing one of them moves the whole catalogue.
   */
  @ApiPropertyOptional({
    example: 5,
    description: 'Delivery time inside Dhaka, in days. Shop-wide default.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(MIN_DELIVERY_DAYS)
  @Max(MAX_DELIVERY_DAYS)
  deliveryInsideDays?: number;

  @ApiPropertyOptional({
    example: 10,
    description: 'Delivery time outside Dhaka, in days. Shop-wide default.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(MIN_DELIVERY_DAYS)
  @Max(MAX_DELIVERY_DAYS)
  deliveryOutsideDays?: number;
}
