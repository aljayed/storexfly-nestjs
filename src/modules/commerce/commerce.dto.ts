import { Transform, Type } from 'class-transformer';
import {
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
