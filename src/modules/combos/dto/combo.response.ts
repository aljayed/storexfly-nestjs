import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { centsToDollars } from '../../../common/utils/money.util';
import type {
  ComboItemRow,
  ComboRow,
  ProductRow,
} from '../../../database/schema';

/** A combo member with enough product context to render it anywhere. */
export class ComboItemResponse {
  @ApiProperty() productId!: string;
  @ApiProperty({ description: 'Units of this product per combo set' })
  qty!: number;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
  @ApiProperty() unit!: string;
  @ApiProperty({ description: 'Base unit price (dollars)' }) price!: number;
  @ApiProperty() stock!: number;
  @ApiProperty() emoji!: string;
  @ApiProperty() tone!: string;
  @ApiPropertyOptional({ description: 'Cover photo, when the product has one' })
  image?: string;
}

/** A combo offer with its members and the computed savings. */
export class ComboResponse {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() emoji!: string;
  @ApiProperty() blurb!: string;
  @ApiProperty({ description: 'Combo price (dollars)' }) price!: number;
  @ApiProperty({
    description: 'Summed member value at base prices (dollars)',
  })
  value!: number;
  @ApiProperty({ description: 'value − price (dollars, ≥ 0)' }) save!: number;
  @ApiProperty() active!: boolean;
  @ApiProperty({ type: [ComboItemResponse] }) items!: ComboItemResponse[];

  static fromRows(
    combo: ComboRow,
    items: (ComboItemRow & { product: ProductRow })[],
  ): ComboResponse {
    const valueCents = items.reduce(
      (sum, i) => sum + i.product.priceCents * i.qty,
      0,
    );
    return {
      id: combo.id,
      name: combo.name,
      emoji: combo.emoji,
      blurb: combo.blurb,
      price: centsToDollars(combo.priceCents),
      value: centsToDollars(valueCents),
      save: centsToDollars(Math.max(0, valueCents - combo.priceCents)),
      active: combo.active,
      items: items.map((i) => ({
        productId: i.productId,
        qty: i.qty,
        name: i.product.name,
        slug: i.product.slug,
        unit: i.product.unit,
        price: centsToDollars(i.product.priceCents),
        stock: i.product.stock,
        emoji: i.product.emoji,
        tone: i.product.tone,
        image: i.product.images?.[0] ?? undefined,
      })),
    };
  }
}
