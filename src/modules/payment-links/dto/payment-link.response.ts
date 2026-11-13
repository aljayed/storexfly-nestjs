import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** 'expired' is a link whose deadline passed unpaid; it is never stored. */
export type PaymentLinkState =
  | 'active'
  | 'paid'
  | 'cancelled'
  | 'expired'
  | 'refunded';

/** One link as the seller's console sees it. Money in major units. */
export class PaymentLinkResponse {
  @ApiProperty() id!: string;
  @ApiProperty() token!: string;
  @ApiProperty({ description: 'The URL to send the buyer' }) url!: string;
  @ApiProperty() title!: string;
  @ApiPropertyOptional() description?: string;
  @ApiProperty() amount!: number;
  @ApiProperty({ enum: ['active', 'paid', 'cancelled', 'expired', 'refunded'] })
  state!: PaymentLinkState;
  @ApiPropertyOptional() expiresAt?: string;
  @ApiProperty() createdAt!: string;
  @ApiPropertyOptional() paidAt?: string;
  @ApiPropertyOptional() trxId?: string;
  @ApiPropertyOptional() instrument?: string;
  @ApiPropertyOptional() payerName?: string;
  @ApiPropertyOptional() payerPhone?: string;
  @ApiPropertyOptional() payerEmail?: string;
  @ApiPropertyOptional() payerNote?: string;
  @ApiPropertyOptional() refundedAt?: string;
}

/** Totals over every link the shop has made. Money in major units. */
export class PaymentLinkSummaryResponse {
  @ApiProperty() collected!: number;
  @ApiProperty() collectedCount!: number;
  @ApiProperty() awaiting!: number;
  @ApiProperty() awaitingCount!: number;
}

export class PaymentLinkListResponse {
  @ApiProperty({
    description:
      'Whether a new link could be paid right now - false while the card ' +
      'gateway is switched off or the shop is closed.',
  })
  available!: boolean;
  @ApiPropertyOptional({
    description: 'Processing fee taken from each payment at payout, in %',
  })
  feePercent?: number;
  @ApiProperty({ type: PaymentLinkSummaryResponse })
  summary!: PaymentLinkSummaryResponse;
  @ApiProperty({ type: [PaymentLinkResponse] }) links!: PaymentLinkResponse[];
}

/**
 * The buyer's view, read by token. Deliberately thin: it says what is being
 * asked for and by whom, and - once paid - that it was. Who paid and what
 * they wrote stays with the shop.
 */
export class PublicPaymentLinkResponse {
  @ApiProperty() token!: string;
  @ApiProperty() title!: string;
  @ApiPropertyOptional() description?: string;
  @ApiProperty() amount!: number;
  @ApiProperty({ example: 'BDT' }) currency!: string;
  @ApiProperty({ enum: ['active', 'paid', 'cancelled', 'expired', 'refunded'] })
  state!: PaymentLinkState;
  @ApiProperty({
    description: 'False when the link is open but cannot be paid right now',
  })
  payable!: boolean;
  @ApiPropertyOptional() expiresAt?: string;
  @ApiPropertyOptional() paidAt?: string;
  @ApiPropertyOptional() trxId?: string;
  @ApiProperty() shopName!: string;
  @ApiProperty() shopHandle!: string;
}

export class PayPaymentLinkResponse {
  @ApiProperty({ description: 'Hosted payment page to send the buyer to' })
  paymentUrl!: string;
}
