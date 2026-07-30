import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type {
  ShopRow,
  SubscriptionPaymentRow,
  SubscriptionRow,
} from '../../../database/schema';

/** One row of the platform-payment ledger. Amounts in major units (৳). */
export class SubscriptionPaymentResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ['shop_creation', 'renewal'] }) type!: string;
  @ApiProperty({ enum: ['auto', 'manual'] }) method!: string;
  @ApiProperty({ example: 599 }) amount!: number;
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

/** Free-plan usage numbers rendered on the Subscription page. */
export class FreeTierUsageResponse {
  @ApiProperty({ example: 4, description: 'Orders taken so far' })
  ordersUsed!: number;
  @ApiProperty({ example: 10, description: 'Free-trial order cap' })
  ordersCap!: number;
  @ApiProperty({ example: 1 }) productsUsed!: number;
  @ApiProperty({ example: 1 }) maxProducts!: number;
}

/** Admin-console subscription view (the Subscription page). */
export class SubscriptionResponse {
  @ApiProperty() id!: string;
  @ApiProperty() shopId!: string;
  @ApiProperty({ enum: ['free', 'paid'] }) plan!: string;
  @ApiPropertyOptional({
    type: FreeTierUsageResponse,
    description: 'Present only on the free plan',
  })
  freeTier?: FreeTierUsageResponse;
  @ApiProperty({ enum: ['active', 'past_due', 'cancelled', 'free'] })
  status!: string;
  @ApiProperty({ example: 599 }) amount!: number;
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
      plan: 'paid',
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

  /** The free-plan card: no subscription row, just limits + usage. */
  static freeTier(
    shop: ShopRow,
    usage: {
      ordersCount: number;
      ordersCap: number;
      productsCount: number;
      maxProducts: number;
      monthlyFeeCents: number;
    },
  ): SubscriptionResponse {
    return {
      id: shop.id,
      shopId: shop.id,
      plan: 'free',
      freeTier: {
        ordersUsed: usage.ordersCount,
        ordersCap: usage.ordersCap,
        productsUsed: usage.productsCount,
        maxProducts: usage.maxProducts,
      },
      status: 'free',
      amount: usage.monthlyFeeCents / 100,
      currency: shop.currency,
      autoDebit: false,
      nextAmount: usage.monthlyFeeCents / 100,
      startedAt: shop.createdAt.toISOString(),
      nextBillingAt: shop.createdAt.toISOString(),
      dueNow: false,
      shopLive: shop.live,
      payments: [],
    };
  }
}

/** Pre-shop "creation fee" payment state for the onboarding wizard. */
export class ShopCreditResponse {
  @ApiProperty() paid!: boolean;
  /** Amount actually charged (after any coupon), major units (৳). */
  @ApiProperty({ example: 599 }) amount!: number;
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
