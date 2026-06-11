import { ApiProperty } from '@nestjs/swagger';

/** Checkout confirmation (the `CheckoutResult` interface from the handoff). */
export class CheckoutResultResponse {
  @ApiProperty({ example: '#1043' }) orderId!: string;
  @ApiProperty({ description: 'Total charged (dollars)' }) total!: number;
  @ApiProperty({ enum: ['mbank', 'card', 'cod'] }) paymentMethod!: string;
  @ApiProperty() qty!: number;
  @ApiProperty({ example: 'Tomorrow, by 7 PM' }) eta!: string;
}
