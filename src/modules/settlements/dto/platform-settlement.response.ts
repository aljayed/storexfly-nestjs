import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { PayoutBank } from '../../../database/schema';
import { SettlementMonthResponse } from './settlement.response';

/** One shop's numbers for the selected period, in the shop's own currency. */
export class PlatformSettlementRowResponse extends SettlementMonthResponse {
  @ApiProperty() shopId!: string;
  @ApiProperty() shopName!: string;
  @ApiProperty() shopHandle!: string;
  @ApiProperty({ example: 'BDT' }) currency!: string;
}

/** Payout totals per currency - shops can price in different currencies. */
export class PlatformSettlementTotalResponse {
  @ApiProperty({ example: 'BDT' }) currency!: string;
  @ApiProperty({ description: 'Unpaid payouts for the period' })
  pendingPayout!: number;
  @ApiProperty({ description: 'Payouts already marked paid' })
  paidPayout!: number;
}

/**
 * Money owed to a shop that has been deleted: one row per unsettled
 * earnings month, snapshotted when the shop was removed. Amounts in major
 * units of `currency`.
 */
export class DeletedShopSettlementResponse {
  @ApiProperty() id!: string;
  @ApiProperty() shopId!: string;
  @ApiProperty() shopName!: string;
  @ApiProperty() shopHandle!: string;
  @ApiProperty({ example: 'BDT' }) currency!: string;
  @ApiPropertyOptional() ownerEmail?: string;
  @ApiProperty({ example: '2026-06' }) period!: string;
  @ApiProperty() ordersCount!: number;
  @ApiProperty() total!: number;
  @ApiProperty() fees!: number;
  @ApiProperty() payout!: number;
  @ApiPropertyOptional({
    description: 'Per-method breakdown of the online volume',
  })
  methods?: {
    code: string;
    title: string;
    amount: number;
    feePercent: number;
    fee: number;
  }[];
  @ApiPropertyOptional({
    description: 'The payout account on file when the shop was deleted',
  })
  payoutBank?: PayoutBank;
  @ApiProperty({ description: 'Scheduled transfer window start (YYYY-MM-DD)' })
  windowFrom!: string;
  @ApiProperty({ description: 'Scheduled transfer window end (YYYY-MM-DD)' })
  windowTo!: string;
  @ApiProperty() owedAt!: string;
  @ApiPropertyOptional() paidAt?: string;
  @ApiPropertyOptional() note?: string;
  @ApiProperty({ enum: ['owed', 'paid'] }) status!: 'owed' | 'paid';
}

/** Platform-admin settlements page payload for one period. */
export class PlatformSettlementsResponse {
  @ApiProperty({ example: '2026-06' }) period!: string;
  @ApiProperty({
    example: ['2026-06', '2026-05'],
    description: 'Every month with order activity, newest first',
  })
  periods!: string[];
  @ApiProperty({ type: [PlatformSettlementRowResponse] })
  rows!: PlatformSettlementRowResponse[];
  @ApiProperty({ type: [PlatformSettlementTotalResponse] })
  totals!: PlatformSettlementTotalResponse[];
}
