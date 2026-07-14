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

  static fromRow(row: OrderItemRow): OrderItemResponse {
    return {
      productId: row.productId,
      name: row.name,
      qty: row.qty,
      unitPrice: centsToDollars(row.unitPriceCents),
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
    };
  }
}
