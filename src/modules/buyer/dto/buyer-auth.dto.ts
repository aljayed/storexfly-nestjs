import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import type { UserRow } from '../../../database/schema';
import { BuyerGeoDto, type BuyerProfile } from './buyer-overview.dto';

const lower = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class BuyerRegisterDto {
  @ApiProperty({ example: 'Arif Hossain' })
  @IsString()
  @Transform(trim)
  @MinLength(1)
  @MaxLength(160)
  name!: string;

  @ApiProperty({ example: 'aarav@gmail.com' })
  @IsEmail()
  @Transform(lower)
  @MaxLength(254)
  email!: string;

  @ApiProperty({ example: 'min 8 chars' })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;

  // Optional checkout details captured when the account is created inline at
  // checkout, so the new profile is seeded in one round-trip. `phone` holds the
  // 10 digits after +880 and is also checked for conflicts (one account per
  // phone number).
  @ApiProperty({ example: '1712345678', required: false })
  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(24)
  phone?: string;

  @ApiProperty({ example: 'House 12, Road 5, Dhanmondi', required: false })
  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(500)
  address?: string;

  @ApiProperty({ example: 'Dhaka', required: false })
  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(120)
  city?: string;

  @ApiProperty({ example: '1207', required: false })
  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(24)
  pincode?: string;

  @ApiProperty({ type: BuyerGeoDto, required: false, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => BuyerGeoDto)
  geo?: BuyerGeoDto | null;
}

export class BuyerLoginDto {
  @ApiProperty({ example: 'aarav@gmail.com' })
  @IsEmail()
  @Transform(lower)
  email!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  password!: string;
}

/** Public account profile + session token (the storefront-facing shape). */
export class BuyerAuthResponse {
  @ApiProperty() token!: string;
  @ApiProperty() buyer!: BuyerProfile;

  static of(row: UserRow, token: string): BuyerAuthResponse {
    return {
      token,
      buyer: {
        id: row.id,
        name: row.name,
        email: row.email ?? '',
        phone: row.phone,
        address: row.addressLine,
        city: row.addressCity,
        pincode: row.addressPincode,
        geo: row.geo,
        lastPayMethod: row.lastPayMethod,
        emailVerified: row.emailVerified,
        handle: row.handle,
      },
    };
  }
}
