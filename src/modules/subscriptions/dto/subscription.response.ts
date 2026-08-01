import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { PlanView } from '../../billing/billing-settings.service';
import type {
  ShopRow,
  SubscriptionPaymentRow,
  SubscriptionRow,
} from '../../../database/schema';

/** One rung of the plan ladder. Money in major units (৳). */
export class PlanResponse {
  @ApiProperty({ example: 'growth' }) code!: string;
  @ApiProperty({ example: 'Growth' }) name!: string;
  @ApiProperty({ example: 1199 }) price!: number;
  @ApiProperty({
    example: 250000,
    nullable: true,
    description: 'Monthly sales ceiling in ৳; null on the uncapped top plan',
  })
  salesCap!: number | null;
  @ApiProperty({ example: 2 }) sortOrder!: number;

  static from(plan: PlanView): PlanResponse {
    return {
      code: plan.code,
      name: plan.name,
      price: plan.price,
      salesCap: plan.salesCap,
      sortOrder: plan.sortOrder,
    };
  }
}

/** One row of the platform-payment ledger. Amounts in major units (৳). */
export class SubscriptionPaymentResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ['shop_creation', 'renewal', 'upgrade'] }) type!: string;
  @ApiProperty({ enum: ['auto', 'manual'] }) method!: string;
  @ApiProperty({ example: 599 }) amount!: number;
  @ApiProperty({ example: 'BDT' }) currency!: string;
  @ApiPropertyOptional({ example: 'growth' }) planCode?: string;
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
      planCode: row.planCode ?? undefined,
      couponCode: row.couponCode ?? undefined,
      discount: row.discountCents ? row.discountCents / 100 : undefined,
      periodStart: row.periodStart?.toISOString(),
      periodEnd: row.periodEnd?.toISOString(),
      paidAt: row.paidAt.toISOString(),
    };
  }
}

/** The sales meter the plan's cap is measured against. */
export class PlanUsageResponse {
  @ApiProperty({ example: 84500, description: 'Sales this period, in ৳' })
  sales!: number;
  @ApiProperty({
    example: 100000,
    nullable: true,
    description: 'The plan cap in ৳; null when uncapped',
  })
  cap!: number | null;
  @ApiProperty({ example: 85, description: 'Share of the cap used, 0–999' })
  pct!: number;
  @ApiProperty() periodStart!: string;
  @ApiProperty() periodEnd!: string;
  @ApiProperty({ description: 'Sales have reached or passed the cap' })
  capReached!: boolean;
  @ApiPropertyOptional({
    description:
      'When selling stops unless the seller upgrades (auto-scale off only)',
  })
  graceEndsAt?: string;
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
  /** Free trial or a paid rung of the ladder. */
  @ApiProperty({ enum: ['free', 'paid'] }) tier!: string;
  @ApiPropertyOptional({
    type: FreeTierUsageResponse,
    description: 'Present only on the free plan',
  })
  freeTier?: FreeTierUsageResponse;
  @ApiProperty({ enum: ['active', 'past_due', 'cancelled', 'free'] })
  status!: string;
  /** The rung the shop is on. On the free plan this is the entry rung. */
  @ApiProperty({ type: PlanResponse }) plan!: PlanResponse;
  /** The whole ladder, cheapest first — what the seller can move to. */
  @ApiProperty({ type: [PlanResponse] }) plans!: PlanResponse[];
  @ApiPropertyOptional({
    type: PlanResponse,
    description: 'A downgrade waiting for the paid-up period to end',
  })
  scheduledPlan?: PlanResponse;
  @ApiPropertyOptional({
    type: PlanUsageResponse,
    description: 'Absent on the free plan, which has no sales cap',
  })
  usage?: PlanUsageResponse;
  @ApiProperty({
    description: 'Move up a plan automatically at 100% of the cap',
  })
  autoScale!: boolean;
  @ApiProperty({
    description:
      'Start every billing period on the entry plan and let auto-scale climb again',
  })
  autoReset!: boolean;
  /** The rung auto-reset returns to, and where a new shop starts. */
  @ApiProperty({ type: PlanResponse }) entryPlan!: PlanResponse;
  @ApiProperty({ example: 599 }) amount!: number;
  @ApiProperty({ example: 'BDT' }) currency!: string;
  @ApiProperty() autoDebit!: boolean;
  /** What the next renewal will actually charge (after any pending coupon). */
  @ApiProperty({ example: 299.75 }) nextAmount!: number;
  /** The same charge before any coupon — what renewals settle at from then on. */
  @ApiProperty({ example: 599 }) nextFullAmount!: number;
  @ApiPropertyOptional({
    type: PlanResponse,
    description:
      'Set when the next renewal moves the shop to another plan (a parked downgrade, or auto-reset)',
  })
  nextPlan?: PlanResponse;
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
    ladder: {
      plan: PlanView;
      plans: PlanView[];
      scheduledPlan: PlanView | null;
      /** The plan the next renewal bills for, or null to stay put. */
      nextPlan: PlanView | null;
      entryPlan: PlanView;
      salesCents: number;
      periodStart: Date;
      periodEnd: Date;
      graceMs: number;
    },
  ): SubscriptionResponse {
    const capCents = ladder.plan.salesCapCents;
    const capReached = capCents !== null && ladder.salesCents >= capCents;
    return {
      id: sub.id,
      shopId: sub.shopId,
      tier: 'paid',
      plan: PlanResponse.from(ladder.plan),
      plans: ladder.plans.map(PlanResponse.from),
      scheduledPlan: ladder.scheduledPlan
        ? PlanResponse.from(ladder.scheduledPlan)
        : undefined,
      entryPlan: PlanResponse.from(ladder.entryPlan),
      autoScale: sub.autoScale,
      autoReset: sub.autoReset,
      usage: {
        sales: ladder.salesCents / 100,
        cap: ladder.plan.salesCap,
        // Capped at 999 so a runaway month can't blow up a progress bar.
        pct:
          capCents === null || capCents === 0
            ? 0
            : Math.min(999, Math.round((ladder.salesCents / capCents) * 100)),
        periodStart: ladder.periodStart.toISOString(),
        periodEnd: ladder.periodEnd.toISOString(),
        capReached,
        graceEndsAt:
          sub.capExceededAt && !sub.autoScale
            ? new Date(
                sub.capExceededAt.getTime() + ladder.graceMs,
              ).toISOString()
            : undefined,
      },
      status: sub.status,
      amount: sub.amountCents / 100,
      currency: sub.currency,
      autoDebit: sub.autoDebit,
      // Auto-reset (or a parked downgrade) re-prices the next renewal, so
      // quote that plan's price, never the one being left behind. A coupon
      // bought at a dearer price can't turn a renewal into a refund.
      nextAmount:
        Math.max(
          0,
          (ladder.nextPlan?.priceCents ?? sub.amountCents) -
            sub.pendingDiscountCents,
        ) / 100,
      nextFullAmount: (ladder.nextPlan?.priceCents ?? sub.amountCents) / 100,
      nextPlan: ladder.nextPlan
        ? PlanResponse.from(ladder.nextPlan)
        : undefined,
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

  /**
   * The free-plan card: no subscription row, just trial limits and usage. The
   * ladder still rides along so the card can show what subscribing buys —
   * `plan` is the entry rung the shop would land on.
   */
  static freeTier(
    shop: ShopRow,
    usage: {
      ordersCount: number;
      ordersCap: number;
      productsCount: number;
      maxProducts: number;
      entryPlan: PlanView;
      plans: PlanView[];
    },
  ): SubscriptionResponse {
    return {
      id: shop.id,
      shopId: shop.id,
      tier: 'free',
      plan: PlanResponse.from(usage.entryPlan),
      plans: usage.plans.map(PlanResponse.from),
      entryPlan: PlanResponse.from(usage.entryPlan),
      autoScale: false,
      autoReset: false,
      freeTier: {
        ordersUsed: usage.ordersCount,
        ordersCap: usage.ordersCap,
        productsUsed: usage.productsCount,
        maxProducts: usage.maxProducts,
      },
      status: 'free',
      amount: usage.entryPlan.price,
      currency: shop.currency,
      autoDebit: false,
      nextAmount: usage.entryPlan.price,
      nextFullAmount: usage.entryPlan.price,
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
