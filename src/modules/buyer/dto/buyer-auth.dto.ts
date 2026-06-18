import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import type { BuyerRow } from '../../../database/schema';
import type { BuyerProfile } from './buyer-overview.dto';

const lower = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class BuyerRegisterDto {
  @ApiProperty({ example: 'Aarav Sharma' })
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MinLength(1)
  @MaxLength(160)
  name!: string;

  @ApiProperty({ example: 'aarav@gmail.com' })
  @IsEmail()
  @Transform(lower)
  @MaxLength(320)
  email!: string;

  @ApiProperty({ example: 'min 8 chars' })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;
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

/** Public buyer profile + session token. */
export class BuyerAuthResponse {
  @ApiProperty() token!: string;
  @ApiProperty() buyer!: BuyerProfile;

  static of(row: BuyerRow, token: string): BuyerAuthResponse {
    return {
      token,
      buyer: {
        id: row.id,
        name: row.name,
        email: row.email,
        phone: row.phone,
        address: row.addressLine,
        city: row.addressCity,
        pincode: row.addressPincode,
        geo: row.geo,
      },
    };
  }
}
