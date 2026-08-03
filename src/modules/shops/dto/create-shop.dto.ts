import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import type { BrandSwatchId } from '../../../common/constants/brand-swatches';
import {
  brandSwatchEnum,
  shopCategoryEnum,
} from '../../../database/schema/enums';
import { SubmitKycDto } from './kyc.dto';

type ShopCategory = (typeof shopCategoryEnum.enumValues)[number];

/** Create-shop wizard submission (README §2). */
export class CreateShopDto {
  @ApiProperty({ example: 'Mango Shop' })
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  name!: string;

  @ApiPropertyOptional({
    enum: ['free', 'paid'],
    description:
      "Pricing tier. 'free' is the trial: an unlimited catalog but only 10 lifetime orders (one free shop per seller).",
  })
  @IsOptional()
  @IsEnum(['free', 'paid'])
  plan?: 'free' | 'paid';

  @ApiProperty({ example: 'mango-shop', description: 'URL handle' })
  @IsString()
  @Matches(/^[a-z0-9-]+$/, {
    message: 'Handle may only contain lowercase letters, numbers and hyphens',
  })
  @MinLength(2)
  @MaxLength(80)
  handle!: string;

  @ApiPropertyOptional({ example: 'Tropical fruit, delivered fresh.' })
  @IsOptional()
  @IsString()
  @MaxLength(240)
  tagline?: string;

  @ApiProperty({ enum: shopCategoryEnum.enumValues })
  @IsEnum(shopCategoryEnum.enumValues)
  cat!: ShopCategory;

  @ApiProperty({ enum: brandSwatchEnum.enumValues })
  @IsEnum(brandSwatchEnum.enumValues)
  brandId!: BrandSwatchId;

  // Optional business verification captured during onboarding. Sellers can
  // skip this entirely and complete it later from the console.
  @ApiPropertyOptional({ type: SubmitKycDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => SubmitKycDto)
  kyc?: SubmitKycDto;
}
