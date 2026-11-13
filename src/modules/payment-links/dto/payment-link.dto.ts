import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsEmail,
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

/** Smallest and largest amount one link may ask for, in ৳. */
export const PAYMENT_LINK_MIN = 10;
// SSLCommerz refuses a single transaction above this.
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

/** Seller: ask a buyer for an amount. Money in major units (৳). */
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
  @Min(PAYMENT_LINK_MIN)
  @Max(PAYMENT_LINK_MAX)
  amount!: number;

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
