import { ApiProperty } from '@nestjs/swagger';

import { ApiPropertyOptional } from '@nestjs/swagger';

/** Checkout confirmation (the `CheckoutResult` interface from the handoff). */
export class CheckoutResultResponse {
  @ApiProperty({ example: '#1043' }) orderId!: string;
  @ApiProperty({
    description: 'Total charged, delivery included (currency units)',
  })
  total!: number;
  @ApiProperty({ description: 'Delivery charge included in the total' })
  delivery!: number;
  @ApiProperty({ example: 'cod', description: 'Payment-method code' })
  paymentMethod!: string;
  @ApiProperty() qty!: number;
  @ApiProperty({ example: 'Within 2–3 days' }) eta!: string;
  @ApiProperty({
    enum: ['Paid', 'Due', 'Pending'],
    description:
      "'Due' = pay on delivery / seller confirms receipt; 'Pending' = finish paying at `paymentUrl`.",
  })
  payStatus!: string;
  @ApiPropertyOptional({
    description: 'bKash hosted-checkout URL to redirect the buyer to.',
  })
  paymentUrl?: string;
}
