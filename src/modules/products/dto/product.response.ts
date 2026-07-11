import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { centsToDollars } from '../../../common/utils/money.util';
import type { ProductHighlight, ProductRow } from '../../../database/schema';
import type { ListingType } from '../../../database/schema/enums';

/** Public-facing product shape (the `Product` interface from the design handoff). */
export class ProductResponse {
  @ApiProperty() id!: string;
  @ApiProperty() shopId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
  @ApiProperty() cat!: string;
  @ApiProperty({
    enum: ['sale', 'showcase'],
    description:
      "'sale' = online checkout; 'showcase' = advertise-only, contact the seller to buy.",
  })
  listingType!: ListingType;
  @ApiProperty({ example: 38, description: 'Unit price in dollars' })
  price!: number;
  @ApiProperty({ example: 'box of 12' }) unit!: string;
  @ApiProperty() stock!: number;
  @ApiProperty({ example: 70, description: 'Delivery charge inside Dhaka (0 = free)' })
  deliveryDhaka!: number;
  @ApiProperty({ example: 120, description: 'Delivery charge outside Dhaka (0 = free)' })
  deliveryOutside!: number;
  @ApiProperty() emoji!: string;
  @ApiProperty() tone!: string;
  @ApiPropertyOptional() tag?: string;
  @ApiProperty({
    type: [String],
    description: 'Payment methods buyers may use (mbank | card | cod)',
  })
  paymentMethods!: string[];
  @ApiProperty() rating!: number;
  @ApiProperty({ description: 'Review/sold count' }) reviews!: number;
  @ApiProperty() blurb!: string;
  @ApiPropertyOptional({ type: [String] }) images?: string[];
  @ApiProperty({ description: 'Seller-authored product highlights' })
  highlights!: ProductHighlight[];
  @ApiPropertyOptional({ description: 'Optional YouTube product video URL' })
  videoUrl?: string;

  static fromRow(row: ProductRow): ProductResponse {
    return {
      id: row.id,
      shopId: row.shopId,
      name: row.name,
      slug: row.slug,
      cat: row.cat,
      listingType: row.listingType,
      price: centsToDollars(row.priceCents),
      unit: row.unit,
      stock: row.stock,
      deliveryDhaka: centsToDollars(row.deliveryDhakaCents),
      deliveryOutside: centsToDollars(row.deliveryOutsideCents),
      emoji: row.emoji,
      tone: row.tone,
      tag: row.tag ?? undefined,
      // Older rows predating this column fall back to all three methods.
      paymentMethods:
        row.paymentMethods && row.paymentMethods.length
          ? row.paymentMethods
          : ['mbank', 'card', 'cod'],
      rating: row.rating,
      reviews: row.reviewsCount,
      blurb: row.blurb,
      images: row.images ?? undefined,
      highlights: row.highlights ?? [],
      videoUrl: row.videoUrl ?? undefined,
    };
  }
}
