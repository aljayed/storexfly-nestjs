import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsInt,
  IsNotEmptyObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { mobileBankAppEnum } from '../../../database/schema/enums';

type MobileBankApp = (typeof mobileBankAppEnum.enumValues)[number];

class ContactDto {
  @ApiProperty({ example: 'Aarav Sharma' })
  @IsString()
  @MaxLength(160)
  name!: string;

  @ApiProperty({ example: '+8801712345678' })
  @IsString()
  @Matches(/^\+?[0-9\s-]{6,20}$/, { message: 'Enter a valid phone number' })
  phone!: string;

  @ApiPropertyOptional({ example: 'aarav.sharma@gmail.com' })
  @IsOptional()
  @IsEmail()
  email?: string;
}

class GeoDto {
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) lat?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) lng?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) x?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) y?: number;
}

class AddressDto {
  @ApiProperty({ example: '12 Orchard Lane' })
  @IsString()
  @MaxLength(240)
  line!: string;

  @ApiProperty({ example: 'Greenwood, Riverside City' })
  @IsString()
  @MaxLength(240)
  area!: string;

  @ApiProperty({ example: '1207' })
  @IsString()
  @MaxLength(20)
  pincode!: string;

  @ApiPropertyOptional({ type: GeoDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => GeoDto)
  geo?: GeoDto;
}

/** Inline product-page checkout payload (the `CheckoutRequest` interface). */
export class CheckoutDto {
  @ApiProperty()
  @IsString()
  shopId!: string;

  @ApiProperty()
  @IsString()
  productId!: string;

  @ApiProperty({ example: 1, minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  qty!: number;

  @ApiProperty({ type: ContactDto })
  @IsNotEmptyObject()
  @ValidateNested()
  @Type(() => ContactDto)
  contact!: ContactDto;

  @ApiProperty({ type: AddressDto })
  @IsNotEmptyObject()
  @ValidateNested()
  @Type(() => AddressDto)
  address!: AddressDto;

  @ApiProperty({
    example: 'cod',
    description:
      'Code of a platform-configured payment method — validated against the live catalog',
  })
  @IsString()
  @MaxLength(40)
  paymentMethod!: string;

  @ApiPropertyOptional({ enum: mobileBankAppEnum.enumValues })
  @IsOptional()
  @IsEnum(mobileBankAppEnum.enumValues)
  mobileBankApp?: MobileBankApp;
}
