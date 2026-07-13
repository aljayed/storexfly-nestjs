import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { SettlementStatus } from '../settlement.constants';

/** Per-method fee breakdown for one earnings month (major currency units). */
export class SettlementFeesResponse {
  @ApiProperty({ description: '3% maintenance charge on mobile banking' })
  mbank!: number;
  @ApiProperty({ description: '4.5% SSLCommerz fee on card payments' })
  card!: number;
  @ApiProperty() total!: number;
}

/** One earnings month of a shop, either computed live or a paid snapshot. */
export class SettlementMonthResponse {
  @ApiProperty({ example: '2026-06', description: 'Earnings month "YYYY-MM"' })
  period!: string;
  @ApiProperty() ordersCount!: number;
  @ApiProperty({ description: 'All paid orders (every method)' })
  total!: number;
  @ApiProperty({ description: 'Collected by the seller in cash — no payout' })
  cod!: number;
  @ApiProperty({ description: 'bKash / Nagad / Rocket volume' })
  mbank!: number;
  @ApiProperty({ description: 'Card & other SSLCommerz volume' })
  card!: number;
  @ApiProperty({ description: 'Orders recorded manually (no gateway)' })
  other!: number;
  @ApiProperty({ type: SettlementFeesResponse }) fees!: SettlementFeesResponse;
  @ApiProperty({
    description: 'Online revenue minus fees — what gets paid out',
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
  @ApiProperty({ example: { mbank: 3, card: 4.5 } })
  feePercents!: { mbank: number; card: number };
  @ApiProperty({ type: [SettlementMonthResponse] })
  months!: SettlementMonthResponse[];
}
