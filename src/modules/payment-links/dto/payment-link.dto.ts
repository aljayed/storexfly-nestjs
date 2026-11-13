import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  PAYMENT_LINK_CURRENCIES,
  type PaymentLinkCurrency,
} from '../../../database/schema/payment-links.schema';

/** BDT minimum; foreign-currency limits are enforced after gateway conversion. */
export const PAYMENT_LINK_MIN = 10;
// Input ceiling in major units. SSLCommerz also enforces BDT 500,000 after FX.
export const PAYMENT_LINK_MAX = 500_000;

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
/** An optional field left blank is the same as one never sent. */
const blankToUndefined = ({ value }: { value: unknown }) =>
  typeof value === 'string' && value.trim() === ''
    ? undefined
    : typeof value === 'string'
      ? value.trim()
      : value;

/** Seller: ask a buyer for an amount in the selected currency's major units. */
export class CreatePaymentLinkDto {
  @ApiProperty({ example: 'Custom cake - 2 kg' })
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  title!: string;

  @ApiPropertyOptional({ example: 'Advance for the order we discussed.' })
  @IsOptional()
  @Transform(blankToUndefined)
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiProperty({ example: 1500 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(PAYMENT_LINK_MAX)
  amount!: number;

  @ApiPropertyOptional({ enum: PAYMENT_LINK_CURRENCIES, default: 'BDT' })
  @IsOptional()
  @IsIn(PAYMENT_LINK_CURRENCIES)
  currency?: PaymentLinkCurrency;

  @ApiPropertyOptional({
    description: 'Last moment the link may be paid. Omit for no deadline.',
  })
  @IsOptional()
  @IsISO8601()
  expiresAt?: string;
}

/** Buyer: who is paying, and anything they want the shop to see with it. */
export class PayPaymentLinkDto {
  @ApiProperty({ example: 'Aarav Sharma' })
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name!: string;

  @ApiProperty({ example: '01712345678' })
  @Transform(trim)
  @IsString()
  @Matches(/^\+?[0-9\s-]{6,20}$/, { message: 'Enter a valid phone number' })
  phone!: string;

  @ApiPropertyOptional({ example: 'aarav@example.com' })
  @IsOptional()
  @Transform(blankToUndefined)
  @IsEmail()
  @MaxLength(320)
  email?: string;

  @ApiPropertyOptional({ example: 'Invoice 214 / for Rahim' })
  @IsOptional()
  @Transform(blankToUndefined)
  @IsString()
  @MaxLength(300)
  note?: string;
}
