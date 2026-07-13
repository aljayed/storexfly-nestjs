import { ApiProperty } from '@nestjs/swagger';
import { SettlementMonthResponse } from './settlement.response';

/** One shop's numbers for the selected period, in the shop's own currency. */
export class PlatformSettlementRowResponse extends SettlementMonthResponse {
  @ApiProperty() shopId!: string;
  @ApiProperty() shopName!: string;
  @ApiProperty() shopHandle!: string;
  @ApiProperty({ example: 'BDT' }) currency!: string;
}

/** Payout totals per currency — shops can price in different currencies. */
export class PlatformSettlementTotalResponse {
  @ApiProperty({ example: 'BDT' }) currency!: string;
  @ApiProperty({ description: 'Unpaid payouts for the period' })
  pendingPayout!: number;
  @ApiProperty({ description: 'Payouts already marked paid' })
  paidPayout!: number;
}

/** Platform-admin settlements page payload for one period. */
export class PlatformSettlementsResponse {
  @ApiProperty({ example: '2026-06' }) period!: string;
  @ApiProperty({
    example: ['2026-06', '2026-05'],
    description: 'Every month with order activity, newest first',
  })
  periods!: string[];
  @ApiProperty({ example: { mbank: 3, card: 4.5 } })
  feePercents!: { mbank: number; card: number };
  @ApiProperty({ type: [PlatformSettlementRowResponse] })
  rows!: PlatformSettlementRowResponse[];
  @ApiProperty({ type: [PlatformSettlementTotalResponse] })
  totals!: PlatformSettlementTotalResponse[];
}
