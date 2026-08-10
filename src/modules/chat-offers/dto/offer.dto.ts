import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsISO8601,
  IsNotEmptyObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { centsToDollars } from '../../../common/utils/money.util';
import type {
  ChatOfferStatus,
  ChatOrderOfferRow,
} from '../../../database/schema';

/** One line the seller adds to an offer. */
export class OfferItemDto {
  @ApiProperty()
  @IsUUID()
  productId!: string;

  @ApiProperty({ example: 2, minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  qty!: number;

  @ApiPropertyOptional({
    example: 3800,
    description:
      "Unit price in ৳. Omit to use the product's current catalog price - " +
      'the point of an offer is that the seller may set their own.',
  })
  @IsOptional()
  @Type(() => Number)
  @Min(0)
  @Max(10_000_000)
  unitPrice?: number;
}

/** Seller composes an offer into a conversation. */
export class CreateOfferDto {
  @ApiProperty({ type: [OfferItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => OfferItemDto)
  items!: OfferItemDto[];

  @ApiPropertyOptional({
    example: 70,
    description:
      "Delivery inside Dhaka in ৳, overriding the items' own rate for this " +
      'offer. 0 = free. Omit to use whatever the items charge.',
  })
  @IsOptional()
  @Type(() => Number)
  @Min(0)
  @Max(100_000)
  deliveryDhaka?: number;

  @ApiPropertyOptional({
    example: 120,
    description: 'Delivery outside Dhaka in ৳. Same rules as deliveryDhaka.',
  })
  @IsOptional()
  @Type(() => Number)
  @Min(0)
  @Max(100_000)
  deliveryOutside?: number;

  @ApiPropertyOptional({ example: 'Special price for you - valid today only.' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;

  @ApiPropertyOptional({ description: 'ISO date after which it lapses.' })
  @IsOptional()
  @IsISO8601()
  expiresAt?: string;
}

class OfferAddressDto {
  @ApiProperty() @IsString() @MaxLength(240) line!: string;
  @ApiProperty() @IsString() @MaxLength(240) area!: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  pincode?: string;
}

/** Buyer accepts or rejects. Accepting needs somewhere to send it and a way to pay. */
export class RespondOfferDto {
  @ApiProperty({ example: true })
  @IsBoolean()
  accept!: boolean;

  @ApiPropertyOptional({
    type: OfferAddressDto,
    description: 'Required when accepting.',
  })
  @IsOptional()
  @IsNotEmptyObject()
  @ValidateNested()
  @Type(() => OfferAddressDto)
  address?: OfferAddressDto;

  @ApiPropertyOptional({
    example: 'cod',
    description: 'Required when accepting.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  paymentMethod?: string;

  @ApiPropertyOptional({ example: '+8801712345678' })
  @IsOptional()
  @IsString()
  @Matches(/^\+?[0-9\s-]{6,20}$/, { message: 'Enter a valid phone number' })
  phone?: string;
}

/** Seller looks a customer up by phone or email to start a thread. */
export class StartWithCustomerDto {
  @ApiPropertyOptional({ example: '01712345678' })
  @IsOptional()
  @IsString()
  @MaxLength(24)
  phone?: string;

  @ApiPropertyOptional({ example: 'buyer@example.com' })
  @IsOptional()
  @IsString()
  @MaxLength(254)
  email?: string;
}

/**
 * What the offer charges to deliver to a zone: one parcel, so the highest
 * rate among its items. Offers made while the seller set one flat charge
 * carry no per-item rates - that agreed number stands for both zones.
 */
function zoneRate(row: ChatOrderOfferRow, zone: 'dhaka' | 'outside'): number {
  const rated = row.items.filter(
    (i) =>
      i.deliveryDhakaCents !== undefined ||
      i.deliveryOutsideCents !== undefined,
  );
  if (!rated.length) return row.deliveryCents;
  return Math.max(
    0,
    ...rated.map(
      (i) =>
        (zone === 'dhaka' ? i.deliveryDhakaCents : i.deliveryOutsideCents) ?? 0,
    ),
  );
}

/** Full offer, as the View screen renders it. */
export class OfferResponse {
  @ApiProperty() id!: string;
  @ApiProperty() conversationId!: string;
  @ApiProperty() shopId!: string;
  @ApiProperty() shopName!: string;
  @ApiProperty() status!: ChatOfferStatus;
  @ApiProperty() items!: {
    productId: string;
    name: string;
    qty: number;
    unitPrice: number;
    lineTotal: number;
    /** Cover snapshot for the line's thumbnail; absent on older offers. */
    imageUrl?: string;
    emoji?: string;
    tone?: string;
    unit?: string;
    slug?: string;
  }[];
  @ApiProperty() itemsSubtotal!: number;
  @ApiProperty({
    description:
      'Delivery actually charged. 0 until the buyer confirms their district ' +
      'and accepts; quote from deliveryDhaka/deliveryOutside before that.',
  })
  delivery!: number;
  @ApiProperty({
    description: 'Items plus delivery once accepted; items only before.',
  })
  total!: number;
  @ApiProperty({ description: "The offer's delivery charge inside Dhaka." })
  deliveryDhaka!: number;
  @ApiProperty({ description: "The offer's delivery charge outside Dhaka." })
  deliveryOutside!: number;
  @ApiPropertyOptional() note?: string;
  @ApiPropertyOptional() expiresAt?: string;
  @ApiPropertyOptional({ description: 'Order reference once accepted.' })
  orderReference?: string;
  @ApiProperty() currency!: string;
  @ApiProperty() createdAt!: string;

  /**
   * Whether it can still be accepted right now. The UI uses this rather than
   * re-deriving the rules, and the accept endpoint re-checks it anyway.
   */
  @ApiProperty() actionable!: boolean;

  static from(
    row: ChatOrderOfferRow,
    extra: { shopName: string; currency: string; orderReference?: string },
  ): OfferResponse {
    const expired = !!row.expiresAt && row.expiresAt.getTime() <= Date.now();
    return {
      id: row.id,
      conversationId: row.conversationId,
      shopId: row.shopId,
      shopName: extra.shopName,
      status: row.status,
      items: row.items.map((i) => ({
        productId: i.productId,
        name: i.name,
        qty: i.qty,
        unitPrice: centsToDollars(i.unitPriceCents),
        lineTotal: centsToDollars(i.unitPriceCents * i.qty),
        imageUrl: i.imageUrl,
        emoji: i.emoji,
        tone: i.tone,
        unit: i.unit,
        slug: i.slug,
      })),
      itemsSubtotal: centsToDollars(row.itemsSubtotalCents),
      delivery: centsToDollars(row.deliveryCents),
      total: centsToDollars(row.totalCents),
      deliveryDhaka: centsToDollars(zoneRate(row, 'dhaka')),
      deliveryOutside: centsToDollars(zoneRate(row, 'outside')),
      note: row.note ?? undefined,
      expiresAt: row.expiresAt?.toISOString(),
      orderReference: extra.orderReference,
      currency: extra.currency,
      createdAt: row.createdAt.toISOString(),
      actionable: row.status === 'pending' && !expired,
    };
  }
}
