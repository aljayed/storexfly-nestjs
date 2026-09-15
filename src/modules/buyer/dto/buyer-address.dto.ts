import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BuyerGeoDto } from './buyer-overview.dto';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
export function addressPhone(value: unknown): unknown {
  return typeof value === 'string'
    ? value
        .replace(/[০-৯]/g, (digit) =>
          String(digit.charCodeAt(0) - '০'.charCodeAt(0)),
        )
        .replace(/\D/g, '')
        .replace(/^(?:880)?0?/, '')
    : value;
}

/** An edit replaces the address fields as one validated recipient. */
export class SaveBuyerAddressDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(40)
  label?: string;

  @ApiProperty()
  @IsString()
  @Transform(trim)
  @MinLength(1)
  @MaxLength(160)
  name!: string;

  @ApiProperty({ example: '1712345678' })
  @IsString()
  @Transform(({ value }) => addressPhone(value))
  @Matches(/^1[3-9]\d{8}$/, {
    message: 'Enter a valid Bangladesh mobile number',
  })
  phone!: string;

  @ApiProperty()
  @IsString()
  @Transform(trim)
  @MinLength(1)
  @MaxLength(500)
  address!: string;

  @ApiProperty()
  @IsString()
  @Transform(trim)
  @MinLength(1)
  @MaxLength(120)
  city!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(24)
  pincode?: string;

  @ApiPropertyOptional({ type: BuyerGeoDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => BuyerGeoDto)
  geo?: BuyerGeoDto | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}
