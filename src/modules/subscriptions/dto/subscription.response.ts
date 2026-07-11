import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type {
  SubscriptionPaymentRow,
  SubscriptionRow,
} from '../../../database/schema';

/** One row of the platform-payment ledger. Amounts in major units (৳). */
export class SubscriptionPaymentResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ['shop_creation', 'renewal'] }) type!: string;
  @ApiProperty({ enum: ['auto', 'manual'] }) method!: string;
  @ApiProperty({ example: 1199 }) amount!: number;
  @ApiProperty({ example: 'BDT' }) currency!: string;
  @ApiPropertyOptional({ example: 'HOOMRI75' }) couponCode?: string;
  @ApiPropertyOptional({ example: 899.25 }) discount?: number;
  @ApiPropertyOptional() periodStart?: string;
  @ApiPropertyOptional() periodEnd?: string;
  @ApiProperty() paidAt!: string;

  static fromRow(row: SubscriptionPaymentRow): SubscriptionPaymentResponse {
    return {
      id: row.id,
      type: row.type,
      method: row.method,
      amount: row.amountCents / 100,
      currency: row.currency,
      couponCode: row.couponCode ?? undefined,
      discount: row.discountCents ? row.discountCents / 100 : undefined,
      periodStart: row.periodStart?.toISOString(),
      periodEnd: row.periodEnd?.toISOString(),
      paidAt: row.paidAt.toISOString(),
    };
  }
}

/** Admin-console subscription view (the Subscription page). */
export class SubscriptionResponse {
  @ApiProperty() id!: string;
  @ApiProperty() shopId!: string;
  @ApiProperty({ enum: ['active', 'past_due', 'cancelled'] }) status!: string;
  @ApiProperty({ example: 1199 }) amount!: number;
  @ApiProperty({ example: 'BDT' }) currency!: string;
  @ApiProperty() autoDebit!: boolean;
  /** What the next renewal will actually charge (after any pending coupon). */
  @ApiProperty({ example: 299.75 }) nextAmount!: number;
  @ApiPropertyOptional({ example: 'HOOMRI75' }) couponCode?: string;
  @ApiPropertyOptional({ example: 899.25 }) couponDiscount?: number;
  @ApiProperty() startedAt!: string;
  @ApiProperty() nextBillingAt!: string;
  @ApiPropertyOptional() cancelledAt?: string;
  /** True when the scheduled payment date has passed and payment is owed. */
  @ApiProperty() dueNow!: boolean;
  @ApiProperty() shopLive!: boolean;
  @ApiProperty({ type: [SubscriptionPaymentResponse] })
  payments!: SubscriptionPaymentResponse[];

  static fromRows(
    sub: SubscriptionRow,
    shopLive: boolean,
    payments: SubscriptionPaymentRow[],
  ): SubscriptionResponse {
    return {
      id: sub.id,
      shopId: sub.shopId,
      status: sub.status,
      amount: sub.amountCents / 100,
      currency: sub.currency,
      autoDebit: sub.autoDebit,
      nextAmount: (sub.amountCents - sub.pendingDiscountCents) / 100,
      couponCode: sub.pendingCouponCode ?? undefined,
      couponDiscount: sub.pendingDiscountCents
        ? sub.pendingDiscountCents / 100
        : undefined,
      startedAt: sub.startedAt.toISOString(),
      nextBillingAt: sub.nextBillingAt.toISOString(),
      cancelledAt: sub.cancelledAt?.toISOString(),
      dueNow: sub.status !== 'cancelled' && sub.nextBillingAt <= new Date(),
      shopLive,
      payments: payments.map(SubscriptionPaymentResponse.fromRow),
    };
  }
}

/** Pre-shop "creation fee" payment state for the onboarding wizard. */
export class ShopCreditResponse {
  @ApiProperty() paid!: boolean;
  /** Amount actually charged (after any coupon), major units (৳). */
  @ApiProperty({ example: 1199 }) amount!: number;
  @ApiProperty({ example: 'BDT' }) currency!: string;
  @ApiPropertyOptional({ example: 'HOOMRI75' }) couponCode?: string;
  @ApiPropertyOptional({ example: 899.25 }) discount?: number;
  @ApiPropertyOptional() paidAt?: string;

  static fromRow(row: SubscriptionPaymentRow): ShopCreditResponse {
    return {
      paid: true,
      amount: row.amountCents / 100,
      currency: row.currency,
      couponCode: row.couponCode ?? undefined,
      discount: row.discountCents ? row.discountCents / 100 : undefined,
      paidAt: row.paidAt.toISOString(),
    };
  }
}
