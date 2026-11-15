import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import type { FeeStanding } from './service-fee-core';

/** The terms, and where one shop stands against them. */
export class ServiceFeeSummaryResponse {
  @ApiProperty({ example: 4.5 }) feePercent!: number;
  @ApiProperty({
    example: 2000,
    description: 'Unpaid balance above which the pay-by clock starts',
  })
  limit!: number;
  @ApiProperty({ example: 3, description: 'Days to pay once over the limit' })
  graceDays!: number;
  @ApiProperty({ description: 'What the shop owes right now' })
  outstanding!: number;
  @ApiProperty({ description: 'Paid beyond what is owed - held for next fees' })
  credit!: number;
  @ApiProperty({ enum: ['clear', 'open', 'due', 'overdue'] })
  standing!: FeeStanding;
  @ApiProperty({ description: 'Suspended over this balance' })
  suspended!: boolean;
  @ApiProperty() unpaidOrders!: number;
  @ApiPropertyOptional({ description: 'When the balance went over the limit' })
  overSince?: string;
  @ApiPropertyOptional({ description: 'The deadline, while one is running' })
  payBy?: string;
}

/** One order's line on a statement. */
export class ServiceFeeOrderResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ example: '#1042' }) reference!: string;
  @ApiProperty() customer!: string;
  @ApiProperty({ description: 'When the order started owing' }) at!: string;
  @ApiProperty({ description: 'What the seller collected themself' })
  collected!: number;
  @ApiProperty({ example: 4.5 }) feePercent!: number;
  @ApiProperty() fee!: number;
  @ApiProperty({ description: "A reseller's margin held by the seller" })
  resellerMargin!: number;
  @ApiPropertyOptional({ description: 'The reseller it is owed to' })
  reseller?: string;
  @ApiProperty({ description: 'fee + reseller margin' }) due!: number;
  @ApiPropertyOptional({ description: 'When a payment covered it' })
  paidAt?: string;
}

export class ServiceFeePaymentResponse {
  @ApiProperty() id!: string;
  @ApiProperty() amount!: number;
  @ApiProperty({
    enum: ['gateway', 'manual', 'payout'],
    description: "'payout' = kept back from a payout the shop was owed",
  })
  via!: 'gateway' | 'manual' | 'payout';
  @ApiPropertyOptional({ description: "via='payout': the cycle it came from" })
  payoutPeriod?: string;
  @ApiPropertyOptional({ example: 'bkash' }) gateway?: string;
  @ApiPropertyOptional({ description: 'Gateway or operator reference' })
  reference?: string;
  @ApiProperty() paidAt!: string;
}

export class ServiceFeeStatementResponse extends ServiceFeeSummaryResponse {
  @ApiProperty({ type: [String], description: 'Gateways open for payment' })
  gateways!: string[];
  @ApiProperty({
    type: [ServiceFeeOrderResponse],
    description: 'Unpaid orders oldest first, then recently settled ones',
  })
  orders!: ServiceFeeOrderResponse[];
  @ApiProperty({ type: [ServiceFeePaymentResponse] })
  payments!: ServiceFeePaymentResponse[];
}

export class PayServiceFeeDto {
  @ApiPropertyOptional({ enum: ['bkash', 'sslcommerz'] })
  @IsOptional()
  @IsIn(['bkash', 'sslcommerz'])
  gateway?: 'bkash' | 'sslcommerz';
}

export class PayServiceFeeResponse {
  @ApiProperty() paymentUrl!: string;
  @ApiProperty({ description: 'What the gateway will collect' })
  amount!: number;
}

/* ── Platform console ────────────────────────────────────────────── */

export class PlatformServiceFeeRowResponse {
  @ApiProperty() shopId!: string;
  @ApiProperty() shopName!: string;
  @ApiProperty() shopHandle!: string;
  @ApiProperty() outstanding!: number;
  @ApiProperty() credit!: number;
  @ApiProperty({ description: 'Reseller margin inside the outstanding amount' })
  resellerMargin!: number;
  @ApiProperty() unpaidOrders!: number;
  @ApiProperty({ enum: ['clear', 'open', 'due', 'overdue'] })
  standing!: FeeStanding;
  @ApiProperty() suspended!: boolean;
  @ApiPropertyOptional() overSince?: string;
  @ApiPropertyOptional() payBy?: string;
  @ApiPropertyOptional() lastPaidAt?: string;
}

export class PlatformServiceFeesResponse {
  @ApiProperty() feePercent!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() graceDays!: number;
  @ApiProperty({ type: [PlatformServiceFeeRowResponse] })
  rows!: PlatformServiceFeeRowResponse[];
  @ApiProperty() totalOutstanding!: number;
  @ApiProperty() suspendedShops!: number;
}

export class RecordServiceFeePaymentDto {
  @ApiProperty({ example: 2350, description: 'Amount received, in taka' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount!: number;

  @ApiPropertyOptional({ description: 'Bank or wallet reference' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}
