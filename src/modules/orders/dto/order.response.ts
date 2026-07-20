import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { centsToDollars } from '../../../common/utils/money.util';
import type {
  DeliveryAddressValue,
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

  static fromRow(row: OrderItemRow): OrderItemResponse {
    return {
      productId: row.productId,
      name: row.name,
      qty: row.qty,
      unitPrice: centsToDollars(row.unitPriceCents),
      variant: row.variant ?? undefined,
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
  @ApiProperty({ enum: ['Store', 'Instagram', 'WhatsApp'] }) channel!: string;
  @ApiPropertyOptional() address?: DeliveryAddressValue;
  @ApiProperty({ description: 'ISO order date' }) date!: string;
  @ApiProperty({ description: 'Delivery charge included in the total' })
  delivery!: number;
  @ApiPropertyOptional({
    enum: ['steadfast', 'pathao'],
    description: 'Courier that booked the parcel (absent = none yet)',
  })
  courierProvider?: string;
  @ApiPropertyOptional({ description: 'Courier consignment id' })
  courierConsignmentId?: string;
  @ApiPropertyOptional({ description: 'Courier tracking code' })
  courierTrackingCode?: string;
  @ApiPropertyOptional({
    description: "Courier delivery status ('pending', 'delivered', …)",
  })
  courierStatus?: string;

  static fromRow(row: OrderRow, items: OrderItemRow[]): OrderResponse {
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
      channel: row.channel,
      address: row.address ?? undefined,
      date: row.placedAt.toISOString(),
      delivery: centsToDollars(row.deliveryCents),
      courierProvider:
        row.courierProvider ??
        (row.courierConsignmentId ? 'steadfast' : undefined),
      courierConsignmentId: row.courierConsignmentId ?? undefined,
      courierTrackingCode: row.courierTrackingCode ?? undefined,
      courierStatus: row.courierStatus ?? undefined,
    };
  }
}
