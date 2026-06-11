import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
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
}
