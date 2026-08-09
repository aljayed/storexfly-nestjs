import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { OrderLineKind } from '../../../common/utils/order-line.util';
import type { DeliveryAddressValue } from '../../../database/schema';

/**
 * One line of a buyer's own order, with enough of the catalogue attached for
 * the profile's order drawer to show it as a card and link through to the
 * item. `slug`/media are null once the product has been deleted - the
 * denormalized name and price still describe what was bought.
 */
export class BuyerOrderLineResponse {
  @ApiProperty() name!: string;
  @ApiProperty() qty!: number;
  @ApiPropertyOptional({ description: '"Size: L · Pack of 3"' })
  variant?: string;
  @ApiProperty({ description: 'Unit price (dollars)' }) unitPrice!: number;
  @ApiProperty({ description: 'Unit price × qty (dollars)' }) lineTotal!: number;
  @ApiProperty({
    enum: ['product', 'delivery', 'discount'],
    description: 'Only "product" lines are things the buyer chose',
  })
  kind!: OrderLineKind;
  @ApiPropertyOptional() imageUrl?: string;
  @ApiPropertyOptional() emoji?: string;
  @ApiPropertyOptional() tone?: string;
  @ApiPropertyOptional({ description: 'Product page slug' }) slug?: string;
}

/** One entry of the order's amount-change history, newest last. */
export class BuyerOrderAdjustmentResponse {
  @ApiProperty() id!: string;
  @ApiProperty() previousTotal!: number;
  @ApiProperty() newTotal!: number;
  @ApiProperty() reason!: string;
  @ApiProperty({ enum: ['pending', 'approved', 'rejected', 'withdrawn'] })
  status!: string;
  @ApiProperty() createdAt!: string;
  @ApiPropertyOptional() resolvedAt?: string;
}

/**
 * Everything the buyer's order drawer shows for one of their own orders.
 * Deliberately separate from the seller-facing `OrderResponse`: it carries
 * product media (which the console's paginated list must not), and none of the
 * shop-side internals.
 */
export class BuyerOrderDetailResponse {
  @ApiProperty({ example: '#1042' }) reference!: string;
  @ApiProperty() shopId!: string;
  @ApiProperty() shopName!: string;
  @ApiProperty() shopHandle!: string;
  @ApiProperty() status!: string;
  @ApiProperty({ enum: ['Paid', 'Due', 'Pending', 'Refunded'] }) pay!: string;
  @ApiProperty({ description: 'ISO order date' }) placedAt!: string;
  @ApiPropertyOptional({ example: 'cod' }) paymentMethod?: string;
  @ApiPropertyOptional({
    example: 'Cash on Delivery',
    description: 'Catalogue title for the method code',
  })
  paymentLabel?: string;
  @ApiProperty({ type: [BuyerOrderLineResponse] })
  items!: BuyerOrderLineResponse[];
  @ApiProperty({ description: 'Units ordered across the product lines' })
  qty!: number;
  @ApiProperty({ description: 'Product lines only (dollars)' })
  itemsSubtotal!: number;
  @ApiProperty({ description: 'Shipping charge included in the total' })
  delivery!: number;
  @ApiProperty({ description: 'Coupon discount already off the total' })
  discount!: number;
  @ApiPropertyOptional() couponCode?: string;
  @ApiProperty() total!: number;
  @ApiPropertyOptional() address?: DeliveryAddressValue;
  @ApiPropertyOptional({ description: 'Courier that has the parcel' })
  courierProvider?: string;
  @ApiPropertyOptional() courierTrackingCode?: string;
  @ApiPropertyOptional() courierStatus?: string;
  @ApiPropertyOptional() courierStatusAt?: string;
  @ApiProperty({ type: [BuyerOrderAdjustmentResponse] })
  adjustments!: BuyerOrderAdjustmentResponse[];
  @ApiProperty({
    description: 'Whether the buyer may still cancel it themselves',
  })
  canCancel!: boolean;
}
