import { ApiProperty } from '@nestjs/swagger';
import { centsToDollars } from '../../../common/utils/money.util';
import type { CustomerRow } from '../../../database/schema';

/** Public-facing customer shape (the `Customer` interface from the handoff). */
export class CustomerResponse {
  @ApiProperty() id!: string;
  @ApiProperty() shopId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() email!: string;
  @ApiProperty({ description: 'From the latest order that carried one' })
  phone!: string;
  @ApiProperty() city!: string;
  @ApiProperty({ description: 'Lifetime order count' }) orders!: number;
  @ApiProperty({ description: 'Lifetime spend (dollars)' }) spent!: number;
  @ApiProperty({ description: 'ISO date of last order', nullable: true })
  last!: string | null;
  @ApiProperty({ description: 'ISO date of first order', nullable: true })
  first!: string | null;
  @ApiProperty({ enum: ['VIP', 'Repeat', 'New'] })
  segment!: 'VIP' | 'Repeat' | 'New';

  static fromRow(row: CustomerRow): CustomerResponse {
    return {
      id: row.id,
      shopId: row.shopId,
      name: row.name,
      email: row.email,
      phone: row.phone,
      city: row.city,
      orders: row.ordersCount,
      spent: centsToDollars(row.spentCents),
      last: row.lastOrderAt ? row.lastOrderAt.toISOString() : null,
      first: row.firstOrderAt ? row.firstOrderAt.toISOString() : null,
      segment: row.segment,
    };
  }
}
