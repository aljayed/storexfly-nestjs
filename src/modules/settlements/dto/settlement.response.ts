import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMethodResponse } from '../payment-methods.controller';
import type { SettlementStatus } from '../settlement.constants';

/** One online payment method's slice of a settlement month. */
export class SettlementMethodResponse {
  @ApiProperty({ example: 'mbank' }) code!: string;
  @ApiProperty({ example: 'Mobile banking' }) title!: string;
  @ApiProperty({ description: 'Volume collected through this method' })
  amount!: number;
  @ApiProperty({ example: 3, description: 'Fee % applied to this volume' })
  feePercent!: number;
  @ApiProperty({ description: 'Fee deducted from this volume' })
  fee!: number;
}

/** One earnings month of a shop, either computed live or a paid snapshot. */
export class SettlementMonthResponse {
  @ApiProperty({ example: '2026-06', description: 'Earnings month "YYYY-MM"' })
  period!: string;
  @ApiProperty() ordersCount!: number;
  @ApiProperty({ description: 'All paid orders (every method)' })
  total!: number;
  @ApiProperty({ description: 'Collected by the seller in cash - no payout' })
  cod!: number;
  @ApiProperty({ description: 'Total collected through online methods' })
  online!: number;
  @ApiProperty({ description: 'Orders recorded manually (no gateway)' })
  other!: number;
  @ApiProperty({
    type: [SettlementMethodResponse],
    description: 'Per-method breakdown of the online volume',
  })
  methods!: SettlementMethodResponse[];
  @ApiProperty({ description: 'Total fees deducted from the online volume' })
  fees!: number;
  @ApiProperty({
    description: 'Online revenue minus fees - what gets paid out',
  })
  payout!: number;
  @ApiProperty({
    enum: ['accruing', 'scheduled', 'due', 'overdue', 'paid', 'none'],
  })
  status!: SettlementStatus;
  @ApiProperty({ example: '2026-07-15', description: 'Payout window opens' })
  windowFrom!: string;
  @ApiProperty({ example: '2026-07-21', description: 'Payout window closes' })
  windowTo!: string;
  @ApiPropertyOptional() paidAt?: string;
  @ApiPropertyOptional({ description: 'Operator payment reference' })
  note?: string;
}

/** Shop-admin settlements page payload. */
export class ShopSettlementsResponse {
  @ApiProperty({
    type: [PaymentMethodResponse],
    description: 'The live payment-method catalog (for fee copy)',
  })
  methods!: PaymentMethodResponse[];
  @ApiProperty({
    nullable: true,
    description: 'Operator-set info banner; null = default copy',
  })
  banner!: string | null;
  @ApiProperty({ type: [SettlementMonthResponse] })
  months!: SettlementMonthResponse[];
}
