import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { centsToDollars } from '../../../common/utils/money.util';
import type { ProductHighlight, ProductRow } from '../../../database/schema';
import type { ListingType } from '../../../database/schema/enums';

/** Public variant option — `priceDelta` in dollars, added to the base price. */
export interface PublicVariantOption {
  id: string;
  label: string;
  priceDelta: number;
}

/** Public variant group ("Size" with its options). */
export interface PublicVariantGroup {
  id: string;
  name: string;
  options: PublicVariantOption[];
}

/** Public multi-buy pack — `price` is the total for `units` units. */
export interface PublicPack {
  id: string;
  label: string;
  units: number;
  price: number;
}

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
  @ApiPropertyOptional({
    example: 45,
    description: 'Seller-entered "compare at" price (absent = no discount).',
  })
  comparePrice?: number;
  @ApiProperty({ example: 'box of 12' }) unit!: string;
  @ApiProperty() stock!: number;
  @ApiProperty({
    example: 70,
    description: 'Delivery charge inside Dhaka (0 = free)',
  })
  deliveryDhaka!: number;
  @ApiProperty({
    example: 120,
    description: 'Delivery charge outside Dhaka (0 = free)',
  })
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
  @ApiProperty({
    description: 'Buyer-facing option groups (≤ 2); deltas in dollars.',
  })
  variantGroups!: PublicVariantGroup[];
  @ApiProperty({
    description: 'Multi-buy bundles; the single unit is always offered too.',
  })
  packs!: PublicPack[];

  static fromRow(row: ProductRow): ProductResponse {
    return {
      id: row.id,
      shopId: row.shopId,
      name: row.name,
      slug: row.slug,
      cat: row.cat,
      listingType: row.listingType,
      price: centsToDollars(row.priceCents),
      comparePrice: row.comparePriceCents
        ? centsToDollars(row.comparePriceCents)
        : undefined,
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
      variantGroups: (row.variantGroups ?? []).map((g) => ({
        id: g.id,
        name: g.name,
        options: g.options.map((o) => ({
          id: o.id,
          label: o.label,
          priceDelta: centsToDollars(o.priceDeltaCents),
        })),
      })),
      packs: (row.packs ?? []).map((p) => ({
        id: p.id,
        label: p.label,
        units: p.units,
        price: centsToDollars(p.priceCents),
      })),
    };
  }
}
