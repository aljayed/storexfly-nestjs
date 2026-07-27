import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsEnum,
  IsInt,
  IsNotEmptyObject,
  IsObject,
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
  @ApiProperty({ example: 'Arif Hossain' })
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

/**
 * One line of a cart checkout — a product with the pick the buyer made for it.
 * The same product may appear twice with different variants; each is its own
 * line (stock is still summed per product).
 */
export class CheckoutItemDto {
  @ApiProperty()
  @IsString()
  productId!: string;

  @ApiProperty({
    example: 2,
    minimum: 1,
    description: 'Units or packs picked.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  qty!: number;

  @ApiPropertyOptional({
    description: 'Chosen variant options, keyed by group id → option id.',
  })
  @IsOptional()
  @IsObject()
  variant?: Record<string, string>;

  @ApiPropertyOptional({ description: 'A multi-buy pack id for this line.' })
  @IsOptional()
  @IsString()
  @MaxLength(24)
  packId?: string;
}

/** Inline product-page checkout payload (the `CheckoutRequest` interface). */
export class CheckoutDto {
  @ApiProperty()
  @IsString()
  shopId!: string;

  @ApiPropertyOptional({
    description:
      'The product being ordered. Exactly one of productId/comboId/items.',
  })
  @IsOptional()
  @IsString()
  productId?: string;

  @ApiPropertyOptional({
    type: [CheckoutItemDto],
    description:
      'Cart checkout: several products from this shop in one order. A cart ' +
      'belongs to exactly one shop, so every product must live in `shopId`.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CheckoutItemDto)
  items?: CheckoutItemDto[];

  @ApiPropertyOptional({
    description: 'A combo offer being ordered instead of a single product.',
  })
  @IsOptional()
  @IsString()
  comboId?: string;

  @ApiPropertyOptional({
    example: 1,
    minimum: 1,
    description:
      'Units, packs, or combo sets — whichever was picked. Ignored for a ' +
      'cart checkout, where every line carries its own qty.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  qty?: number;

  @ApiPropertyOptional({
    description:
      'Chosen variant options, keyed by group id → option id. Required for every group the product defines.',
  })
  @IsOptional()
  @IsObject()
  variant?: Record<string, string>;

  @ApiPropertyOptional({
    description: 'A multi-buy pack id — qty then counts packs, not units.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(24)
  packId?: string;

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
