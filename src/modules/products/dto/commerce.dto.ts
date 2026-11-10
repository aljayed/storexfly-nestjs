import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  COMMERCE_MODES,
  type CommerceMode,
  type CommercePolicy,
  validateCommerce,
} from '../../../common/commerce/commerce';
import { dollarsToCents } from '../../../common/utils/money.util';

export class WholesaleTierDto {
  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  minQty!: number;
  @ApiProperty()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(10_000_000)
  unitPrice!: number;
}
export class CommerceDto {
  @ApiProperty({ enum: COMMERCE_MODES, isArray: true })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  @ArrayUnique()
  @IsIn(COMMERCE_MODES, { each: true })
  channels!: CommerceMode[];
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(10_000_000)
  resellerPrice?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  wholesaleMoq?: number;
  @ApiPropertyOptional({ type: [WholesaleTierDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => WholesaleTierDto)
  wholesaleTiers?: WholesaleTierDto[];
}
export function toCommerce(dto: CommerceDto): CommercePolicy {
  return validateCommerce({
    channels: dto.channels,
    resellerPriceCents:
      dto.resellerPrice == null ? undefined : dollarsToCents(dto.resellerPrice),
    wholesaleMoq: dto.wholesaleMoq,
    wholesaleTiers: dto.wholesaleTiers?.map((t) => ({
      minQty: t.minQty,
      unitPriceCents: dollarsToCents(t.unitPrice),
    })),
  });
}
export function publicCommerce(policy: CommercePolicy | null | undefined) {
  return {
    channels: policy?.channels ?? ['retail'],
    wholesaleMoq: policy?.wholesaleMoq ?? 1,
    wholesaleTiers: (policy?.wholesaleTiers ?? []).map((t) => ({
      minQty: t.minQty,
      unitPrice: t.unitPriceCents / 100,
    })),
  };
}
