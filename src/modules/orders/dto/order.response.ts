import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { centsToDollars } from '../../../common/utils/money.util';
import {
  orderLineKind,
  type OrderLineKind,
} from '../../../common/utils/order-line.util';
import type {
  DeliveryAddressValue,
  OrderAmountAdjustmentRow,
  OrderItemRow,
  OrderRow,
} from '../../../database/schema';

export class OrderItemResponse {
  @ApiProperty() productId!: string | null;
  @ApiProperty() name!: string;
  @ApiProperty() qty!: number;
  @ApiProperty({ description: 'Unit price (dollars)' }) unitPrice!: number;
  @ApiPropertyOptional({
    description: 'What was picked at purchase time ("Size: L · Pack of 3")',
  })
  variant?: string;
  @ApiProperty({
    enum: ['product', 'delivery', 'discount'],
    description:
      'What the line is. Only "product" lines are things the buyer bought - ' +
      'shipping and combo reconciliation ride along so the lines sum to the total.',
  })
  kind!: OrderLineKind;

  static fromRow(row: OrderItemRow): OrderItemResponse {
    return {
      productId: row.productId,
      name: row.name,
      qty: row.qty,
      unitPrice: centsToDollars(row.unitPriceCents),
      variant: row.variant ?? undefined,
      kind: orderLineKind(row),
    };
  }
}

/** One entry of an order's amount-change history (see OrderAmountAdjustment). */
export class OrderAdjustmentResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ description: 'Order total before this change (dollars)' })
  previousTotal!: number;
  @ApiProperty({ description: 'Proposed new order total (dollars)' })
  newTotal!: number;
  @ApiProperty() reason!: string;
  @ApiProperty({ enum: ['pending', 'approved', 'rejected', 'withdrawn'] })
  status!: string;
  @ApiPropertyOptional({
    description: 'When it was approved/declined/withdrawn',
  })
  resolvedAt?: string;
  @ApiProperty({ description: 'When the seller requested the change' })
  createdAt!: string;

  static fromRow(row: OrderAmountAdjustmentRow): OrderAdjustmentResponse {
    return {
      id: row.id,
      previousTotal: centsToDollars(row.previousTotalCents),
      newTotal: centsToDollars(row.newTotalCents),
      reason: row.reason,
      status: row.status,
      resolvedAt: row.resolvedAt?.toISOString(),
      createdAt: row.createdAt.toISOString(),
    };
  }
}

/** Public-facing order shape (the `Order` interface from the design handoff). */
export class OrderResponse {
  @ApiProperty({ example: '#1042', description: 'Human-facing reference' })
  id!: string;
  @ApiProperty() shopId!: string;
  @ApiProperty() customer!: string;
  @ApiPropertyOptional() customerId?: string;
  @ApiProperty() email!: string;
  @ApiPropertyOptional() phone?: string;
  @ApiProperty({ type: [OrderItemResponse] }) items!: OrderItemResponse[];
  @ApiProperty() qty!: number;
  @ApiProperty({ description: 'Order total (dollars)' }) total!: number;
  @ApiProperty({ enum: ['New', 'Packed', 'Shipped', 'Delivered'] })
  status!: string;
  @ApiProperty({ enum: ['Paid', 'Refunded'] }) pay!: string;
  @ApiPropertyOptional({ example: 'cod', description: 'Payment-method code' })
  paymentMethod?: string;
  @ApiProperty({ description: 'Advance amount for protected COD orders' })
  advance!: number;
  @ApiProperty({ description: 'Whether the advance has been confirmed' })
  advancePaid!: boolean;
  @ApiProperty({ description: 'Balance expected on delivery' })
  codDue!: number;
  @ApiProperty({ enum: ['Store', 'Instagram', 'WhatsApp'] }) channel!: string;
  @ApiPropertyOptional() address?: DeliveryAddressValue;
  @ApiProperty({ description: 'ISO order date' }) date!: string;
  @ApiProperty({ description: 'Delivery charge included in the total' })
  delivery!: number;
  @ApiPropertyOptional({
    example: 'EID25',
    description: 'Shop coupon the buyer redeemed (absent = none)',
  })
  couponCode?: string;
  @ApiProperty({
    description: 'Coupon discount already subtracted from the total',
  })
  discount!: number;
  @ApiPropertyOptional({
    enum: ['carrybee', 'steadfast', 'pathao'],
    description: 'Courier that booked the parcel (absent = none yet)',
  })
  courierProvider?: string;
  @ApiPropertyOptional({ description: 'Courier consignment id' })
  courierConsignmentId?: string;
  @ApiPropertyOptional({ description: 'Courier tracking code' })
  courierTrackingCode?: string;
  @ApiPropertyOptional({
    description: "Courier delivery status ('picked', 'delivered', …)",
  })
  courierStatus?: string;
  @ApiPropertyOptional({
    description: 'When the courier last reported that status (ISO)',
  })
  courierStatusAt?: string;
  @ApiPropertyOptional({
    description:
      'What the courier actually collected at the door - below the total on a partial delivery',
  })
  courierCollected?: number;
  @ApiPropertyOptional({ description: 'Courier delivery charge' })
  courierDeliveryFee?: number;
  @ApiPropertyOptional({
    description:
      'Why the parcel failed or came back, as the courier reported it',
  })
  courierFailureReason?: string;
  @ApiPropertyOptional({
    description: 'When the seller handed the parcel over (ISO)',
  })
  handedOverAt?: string;
  @ApiProperty({
    type: [OrderAdjustmentResponse],
    description:
      'Amount-change history (newest last); the pending one, if any, awaits buyer approval',
  })
  adjustments!: OrderAdjustmentResponse[];
  @ApiProperty({
    description:
      'Whether the order is tied to a verified buyer account (matched by a verified email or, later, verified phone). Amount changes are offered only when true - a guest or unverified match has no owner to approve them.',
  })
  hasBuyerAccount!: boolean;

  static fromRow(
    row: OrderRow,
    items: OrderItemRow[],
    adjustments: OrderAmountAdjustmentRow[] = [],
    hasBuyerAccount = false,
  ): OrderResponse {
    return {
      id: row.reference,
      shopId: row.shopId,
      customer: row.customerName,
      customerId: row.customerId ?? undefined,
      email: row.email,
      phone: row.phone ?? undefined,
      items: items.map(OrderItemResponse.fromRow),
      qty: row.qty,
      total: centsToDollars(row.totalCents),
      status: row.status,
      pay: row.pay,
      paymentMethod: row.paymentMethod ?? undefined,
      advance: centsToDollars(row.advanceCents),
      advancePaid: !!row.advancePaidAt,
      codDue: centsToDollars(
        row.advanceCents > 0 ? row.totalCents - row.advanceCents : 0,
      ),
      channel: row.channel,
      address: row.address ?? undefined,
      date: row.placedAt.toISOString(),
      delivery: centsToDollars(row.deliveryCents),
      couponCode: row.couponCode ?? undefined,
      discount: centsToDollars(row.discountCents),
      courierProvider:
        row.courierProvider ??
        (row.courierConsignmentId ? 'steadfast' : undefined),
      courierConsignmentId: row.courierConsignmentId ?? undefined,
      courierTrackingCode: row.courierTrackingCode ?? undefined,
      courierStatus: row.courierStatus ?? undefined,
      courierStatusAt: row.courierStatusAt?.toISOString(),
      courierCollected:
        row.courierCollectedCents != null
          ? centsToDollars(row.courierCollectedCents)
          : undefined,
      courierDeliveryFee:
        row.courierDeliveryFeeCents != null
          ? centsToDollars(row.courierDeliveryFeeCents)
          : undefined,
      courierFailureReason: row.courierFailureReason ?? undefined,
      handedOverAt: row.handedOverAt?.toISOString(),
      adjustments: [...adjustments]
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map(OrderAdjustmentResponse.fromRow),
      hasBuyerAccount,
    };
  }
}
