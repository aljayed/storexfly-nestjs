import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
export class ResellerListingDto {
  @IsUUID() productId!: string;
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(10_000_000)
  sellingPrice!: number;
}
export class UpdateResellerListingDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(10_000_000)
  sellingPrice?: number;
  @IsOptional() @IsBoolean() active?: boolean;
}
/** Reseller sourcing: other suppliers' resellable products. */
export class SourcingQueryDto {
  @IsOptional() @IsString() @MaxLength(80) q?: string;
  @IsOptional() @IsString() @MaxLength(80) category?: string;
  @IsOptional() @IsIn(['new', 'profit', 'rating']) sort?:
    | 'new'
    | 'profit'
    | 'rating';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) page?: number;
}
export class RepriceItemDto {
  @IsUUID() id!: string;
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(10_000_000)
  sellingPrice!: number;
}
/** Several listings repriced in one go (a pricing rule applied to a view). */
export class RepriceListingsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => RepriceItemDto)
  items!: RepriceItemDto[];
}
export class RequestQuoteDto {
  @IsUUID() productId!: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(1_000_000) qty!: number;
  @IsOptional() @IsIn(['bulk', 'sample']) kind?: 'bulk' | 'sample';
  @IsOptional() @IsObject() variant?: Record<string, string>;
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(5)
  @MaxLength(2000)
  message!: string;
}
export class RespondQuoteDto {
  @IsIn(['quote', 'decline']) action!: 'quote' | 'decline';
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(10_000_000)
  unitPrice?: number;
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(30)
  validDays?: number;
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  message!: string;
}
export class QuoteDecisionDto {
  @IsIn(['accept', 'cancel']) action!: 'accept' | 'cancel';
}
export class TradeMessageDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  text!: string;
}
export class OpenDisputeDto {
  @IsUUID() orderId!: string;
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(10)
  @MaxLength(4000)
  reason!: string;
}
export class ResolveDisputeDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(10)
  @MaxLength(4000)
  resolution!: string;
}

export class DisputeDecisionDto {
  @IsIn(['accept', 'escalate']) action!: 'accept' | 'escalate';
}
