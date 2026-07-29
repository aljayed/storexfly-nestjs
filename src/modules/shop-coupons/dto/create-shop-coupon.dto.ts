import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  shopCouponScopeEnum,
  shopCouponTypeEnum,
} from '../../../database/schema/shop-coupons.schema';

type CouponScope = (typeof shopCouponScopeEnum.enumValues)[number];
type CouponType = (typeof shopCouponTypeEnum.enumValues)[number];

/**
 * Create a buyer-facing discount code for a shop.
 *
 * Money fields are in major units (৳) like the rest of the seller-facing API —
 * the service converts them to integer cents.
 */
export class CreateShopCouponDto {
  @ApiProperty({
    example: 'EID25',
    description:
      'Letters, digits, dash and underscore. Stored uppercase and matched ' +
      'case-insensitively; unique within the shop.',
  })
  @IsString()
  @MaxLength(40)
  @Matches(/^[A-Za-z0-9_-]{3,40}$/, {
    message:
      'Use 3–40 letters, numbers, dashes or underscores for the coupon code',
  })
  code!: string;

  @ApiPropertyOptional({ example: 'Eid sale — 25% off everything' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;

  @ApiProperty({ enum: shopCouponTypeEnum.enumValues, example: 'percent' })
  @IsEnum(shopCouponTypeEnum.enumValues)
  discountType!: CouponType;

  @ApiProperty({
    example: 25,
    description:
      'For `percent`: whole-number 1–100. For `fixed`: the taka amount off.',
  })
  @Type(() => Number)
  @Min(1)
  value!: number;

  @ApiPropertyOptional({
    example: 500,
    description:
      'Ceiling on a percentage discount, in ৳. Ignored for fixed coupons.',
  })
  @IsOptional()
  @Type(() => Number)
  @Min(1)
  maxDiscount?: number;

  @ApiPropertyOptional({
    example: 1000,
    description: 'Minimum item subtotal (৳) before the code is accepted.',
  })
  @IsOptional()
  @Type(() => Number)
  @Min(0)
  minOrder?: number;

  @ApiProperty({
    enum: shopCouponScopeEnum.enumValues,
    example: 'all',
    description:
      '`all` = every sale item (showcase items are never orderable online, ' +
      'so they are excluded automatically); `product` needs `productId`; ' +
      '`combo` needs `comboId`.',
  })
  @IsEnum(shopCouponScopeEnum.enumValues)
  scope!: CouponScope;

  @ApiPropertyOptional({ description: 'Required when scope = product.' })
  @IsOptional()
  @IsString()
  productId?: string;

  @ApiPropertyOptional({ description: 'Required when scope = combo.' })
  @IsOptional()
  @IsString()
  comboId?: string;

  @ApiPropertyOptional({ example: true, default: true })
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({ description: 'ISO date; absent = live immediately.' })
  @IsOptional()
  @IsISO8601()
  startsAt?: string;

  @ApiPropertyOptional({ description: 'ISO date; absent = never expires.' })
  @IsOptional()
  @IsISO8601()
  expiresAt?: string;

  @ApiPropertyOptional({
    example: 100,
    description: 'Total times the code may be used; absent = unlimited.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxRedemptions?: number;

  @ApiPropertyOptional({
    example: 1,
    description: 'Times one buyer (by phone) may use it; absent = unlimited.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  perCustomerLimit?: number;
}

/** Every field optional — the seller edits one thing at a time. */
export class UpdateShopCouponDto extends PartialType(CreateShopCouponDto) {}
