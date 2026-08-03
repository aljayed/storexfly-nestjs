import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { CreditPackView } from '../../billing/billing-settings.service';
import type {
  ShopRow,
  SubscriptionPaymentRow,
  SubscriptionRow,
} from '../../../database/schema';

/** One credit pack on the shelf. Money in major units (৳). */
export class CreditPackResponse {
  @ApiProperty({ example: 'credit-200k' }) code!: string;
  @ApiProperty({ example: '৳2,00,000 in sales' }) name!: string;
  @ApiProperty({ example: 3499, description: 'What the pack costs, in ৳' })
  price!: number;
  @ApiProperty({
    example: 200000,
    description: 'How much selling the pack pays for, in ৳',
  })
  salesCredit!: number;
  @ApiProperty({
    example: 1.75,
    description: 'The pack as a share of the sales it covers, e.g. 1.75%',
  })
  ratePct!: number;
  @ApiPropertyOptional({ example: 'Most popular' }) badge?: string;
  @ApiProperty({ example: 2 }) sortOrder!: number;

  static from(pack: CreditPackView): CreditPackResponse {
    return {
      code: pack.code,
      name: pack.name,
      price: pack.price,
      salesCredit: pack.salesCredit,
      ratePct: pack.ratePct,
      badge: pack.badge ?? undefined,
      sortOrder: pack.sortOrder,
    };
  }
}

/** One row of the platform-payment ledger. Amounts in major units (৳). */
export class SubscriptionPaymentResponse {
  @ApiProperty({
    enum: ['credit_pack', 'commission', 'shop_creation', 'renewal', 'upgrade'],
  })
  type!: string;
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ['auto', 'manual'] }) method!: string;
  @ApiProperty({ example: 1899 }) amount!: number;
  @ApiProperty({ example: 'BDT' }) currency!: string;
  @ApiPropertyOptional({
    example: 'credit-100k',
    description: 'The pack bought (or, on retired rows, the plan)',
  })
  planCode?: string;
  @ApiPropertyOptional({
    example: 100000,
    description: 'credit_pack: the selling this purchase paid for, in ৳',
  })
  salesCredit?: number;
  @ApiPropertyOptional({
    example: 240000,
    description: 'commission: the sales the rate was charged on, in ৳',
  })
  billableSales?: number;
  @ApiPropertyOptional({ example: 'LAUNCH50' }) couponCode?: string;
  @ApiPropertyOptional({ example: 949.5 }) discount?: number;
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
      salesCredit:
        row.salesCreditCents === null ? undefined : row.salesCreditCents / 100,
      billableSales:
        row.billableSalesCents === null
          ? undefined
          : row.billableSalesCents / 100,
      couponCode: row.couponCode ?? undefined,
      discount: row.discountCents ? row.discountCents / 100 : undefined,
      periodStart: row.periodStart?.toISOString(),
      periodEnd: row.periodEnd?.toISOString(),
      paidAt: row.paidAt.toISOString(),
    };
  }
}

/** The credit meter: what was bought, what's been sold against it. */
export class CreditStateResponse {
  @ApiProperty({ example: 300000, description: 'Credit ever bought, in ৳' })
  granted!: number;
  @ApiProperty({ example: 218400, description: 'Sold against it so far, in ৳' })
  used!: number;
  @ApiProperty({ example: 81600, description: 'What is left, in ৳' })
  balance!: number;
  @ApiProperty({ example: 73, description: 'Share of the credit used, 0-100' })
  pct!: number;
  @ApiProperty({
    example: 1000000,
    description: 'The most credit this shop may hold at once, in ৳',
  })
  cap!: number;
  @ApiProperty({
    example: 918400,
    description: 'Headroom to buy more right now (cap − balance), in ৳',
  })
  roomToBuy!: number;
  @ApiProperty({ description: 'The balance has run out and selling is paused' })
  exhausted!: boolean;
}

/** The month a verified shop's commission is being counted for. */
export class CommissionStateResponse {
  @ApiProperty({ example: 1.5 }) ratePct!: number;
  @ApiProperty({
    example: 240000,
    description: 'Sales so far this month that the rate applies to, in ৳',
  })
  billableSales!: number;
  @ApiProperty({
    example: 3600,
    description: 'What the bill would be if the month ended now, in ৳',
  })
  accrued!: number;
  @ApiProperty() periodStart!: string;
  @ApiProperty() periodEnd!: string;
  @ApiPropertyOptional({
    example: 3600,
    description: 'An issued bill that has not been paid yet, in ৳',
  })
  due?: number;
  @ApiPropertyOptional({
    description: 'When the storefront pauses unless the due bill is settled',
  })
  dueBy?: string;
  @ApiPropertyOptional() duePeriodStart?: string;
  @ApiPropertyOptional() duePeriodEnd?: string;
}

/**
 * Free-plan usage numbers rendered on the Subscription page. Orders are all
 * the trial meters - the catalog is unlimited on every track.
 */
export class FreeTierUsageResponse {
  @ApiProperty({ example: 4, description: 'Orders taken so far' })
  ordersUsed!: number;
  @ApiProperty({ example: 10, description: 'Free-trial order cap' })
  ordersCap!: number;
}

/** Admin-console subscription view (the Subscription page). */
export class SubscriptionResponse {
  @ApiProperty() id!: string;
  @ApiProperty() shopId!: string;
  /** 'free' until the shop buys its first pack or goes verified. */
  @ApiProperty({ enum: ['free', 'paid'] }) tier!: string;
  @ApiPropertyOptional({
    type: FreeTierUsageResponse,
    description: 'Present only while the shop is on the free trial',
  })
  freeTier?: FreeTierUsageResponse;
  @ApiProperty({ enum: ['active', 'past_due', 'cancelled', 'free'] })
  status!: string;
  /** Which of the two tracks the shop pays on. */
  @ApiProperty({ enum: ['credits', 'commission'] }) billingMode!: string;
  @ApiProperty({
    description:
      'The shop may switch to commission - its trade licence is verified',
  })
  canUseCommission!: boolean;
  @ApiProperty({
    enum: ['unsubmitted', 'pending', 'verified', 'rejected'],
    description: 'Trade-licence verification state, the gate on commission',
  })
  kycStatus!: string;
  @ApiProperty({
    type: CreditStateResponse,
    description: 'Always present - leftover credit is spent on either track',
  })
  credit!: CreditStateResponse;
  @ApiPropertyOptional({
    type: CommissionStateResponse,
    description: 'Present only on the commission track',
  })
  commission?: CommissionStateResponse;
  /** The packs on sale, cheapest first. */
  @ApiProperty({ type: [CreditPackResponse] }) packs!: CreditPackResponse[];
  @ApiProperty({ example: 'BDT' }) currency!: string;
  @ApiProperty({ description: 'Collect the monthly commission automatically' })
  autoDebit!: boolean;
  @ApiProperty() startedAt!: string;
  @ApiProperty({ description: 'When the next commission bill is issued' })
  nextBillingAt!: string;
  @ApiPropertyOptional() cancelledAt?: string;
  /** True when money is owed right now. */
  @ApiProperty() dueNow!: boolean;
  @ApiProperty() shopLive!: boolean;
  @ApiProperty({ type: [SubscriptionPaymentResponse] })
  payments!: SubscriptionPaymentResponse[];

  static fromRows(
    sub: SubscriptionRow,
    shopLive: boolean,
    payments: SubscriptionPaymentRow[],
    view: {
      tier: string;
      freeTier?: FreeTierUsageResponse;
      kycStatus: string;
      canUseCommission: boolean;
      packs: CreditPackView[];
      creditCapCents: number;
      granted: number;
      used: number;
      /** Commission-track only: the month being counted right now. */
      period: { start: Date; end: Date };
      billableSalesCents: number;
      dueGraceMs: number;
    },
  ): SubscriptionResponse {
    const balance = Math.max(0, view.granted - view.used);
    const accruedCents = Math.round(
      (view.billableSalesCents * sub.commissionBps) / 10_000,
    );
    return {
      id: sub.id,
      shopId: sub.shopId,
      tier: view.tier,
      freeTier: view.freeTier,
      status: sub.status,
      billingMode: sub.billingMode,
      canUseCommission: view.canUseCommission,
      kycStatus: view.kycStatus,
      credit: {
        granted: view.granted / 100,
        used: Math.min(view.used, view.granted) / 100,
        balance: balance / 100,
        pct:
          view.granted === 0
            ? 0
            : Math.min(
                100,
                Math.round(
                  (Math.min(view.used, view.granted) / view.granted) * 100,
                ),
              ),
        cap: view.creditCapCents / 100,
        roomToBuy: Math.max(0, view.creditCapCents - balance) / 100,
        exhausted: balance <= 0,
      },
      commission:
        sub.billingMode === 'commission'
          ? {
              ratePct: sub.commissionBps / 100,
              billableSales: view.billableSalesCents / 100,
              accrued: accruedCents / 100,
              periodStart: view.period.start.toISOString(),
              periodEnd: view.period.end.toISOString(),
              due: sub.dueCents ? sub.dueCents / 100 : undefined,
              dueBy: sub.dueSince
                ? new Date(
                    sub.dueSince.getTime() + view.dueGraceMs,
                  ).toISOString()
                : undefined,
              duePeriodStart: sub.duePeriodStart?.toISOString(),
              duePeriodEnd: sub.duePeriodEnd?.toISOString(),
            }
          : undefined,
      packs: view.packs.map(CreditPackResponse.from),
      currency: sub.currency,
      autoDebit: sub.autoDebit,
      startedAt: sub.startedAt.toISOString(),
      nextBillingAt: sub.nextBillingAt.toISOString(),
      cancelledAt: sub.cancelledAt?.toISOString(),
      dueNow: sub.status !== 'cancelled' && sub.dueCents > 0,
      shopLive,
      payments: payments.map(SubscriptionPaymentResponse.fromRow),
    };
  }

  /**
   * The card for a shop that has no subscription row at all - only possible
   * for a shop created before this system existed and not yet touched. The
   * shelf rides along so the card can still show what buying credit costs.
   */
  static bare(
    shop: ShopRow,
    view: {
      freeTier: FreeTierUsageResponse;
      packs: CreditPackView[];
      creditCapCents: number;
    },
  ): SubscriptionResponse {
    return {
      id: shop.id,
      shopId: shop.id,
      tier: 'free',
      freeTier: view.freeTier,
      status: 'free',
      billingMode: 'credits',
      canUseCommission: shop.kycStatus === 'verified',
      kycStatus: shop.kycStatus,
      credit: {
        granted: 0,
        used: 0,
        balance: 0,
        pct: 0,
        cap: view.creditCapCents / 100,
        roomToBuy: view.creditCapCents / 100,
        exhausted: false,
      },
      packs: view.packs.map(CreditPackResponse.from),
      currency: shop.currency,
      autoDebit: false,
      startedAt: shop.createdAt.toISOString(),
      nextBillingAt: shop.createdAt.toISOString(),
      dueNow: false,
      shopLive: shop.live,
      payments: [],
    };
  }
}
