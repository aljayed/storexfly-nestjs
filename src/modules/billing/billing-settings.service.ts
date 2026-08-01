import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import {
  DEFAULT_MONTHLY_FEE_CENTS,
  ENTRY_PLAN_CODE,
  PLAN_TIERS,
} from '../../common/constants/billing';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import {
  subscriptionPlans,
  subscriptions,
  type SubscriptionPlanRow,
} from '../../database/schema';

/** Bounds an operator typo can't escape: ৳1 … ৳100,000 per month. */
export const MIN_MONTHLY_FEE_CENTS = 100;
export const MAX_MONTHLY_FEE_CENTS = 10_000_000;

/** Bounds on a plan's monthly sales cap: ৳1,000 … ৳100 crore. */
export const MIN_SALES_CAP_CENTS = 100_000;
export const MAX_SALES_CAP_CENTS = 100_000_000_000;

/** One rung of the ladder, as the console and the landing page read it. */
export interface PlanView {
  id: string;
  code: string;
  name: string;
  /** Monthly sales ceiling in paisa; null = uncapped. */
  salesCapCents: number | null;
  /** Monthly sales ceiling in whole taka; null = uncapped. */
  salesCap: number | null;
  priceCents: number;
  /** Monthly price in whole taka, e.g. 599. */
  price: number;
  sortOrder: number;
  active: boolean;
}

export interface PricingView {
  /** Entry-plan monthly fee in whole taka, e.g. 599. */
  monthlyFee: number;
  monthlyFeeCents: number;
  currency: string;
  /** The whole ladder, cheapest first. */
  plans: PlanView[];
}

/** The seeded ladder, used when the catalog table can't be read. */
const FALLBACK_PLANS: PlanView[] = PLAN_TIERS.map((tier, i) => ({
  id: tier.code,
  code: tier.code,
  name: tier.name,
  salesCapCents: tier.salesCapCents,
  salesCap: tier.salesCapCents === null ? null : tier.salesCapCents / 100,
  priceCents: tier.priceCents,
  price: tier.priceCents / 100,
  sortOrder: i + 1,
  active: true,
}));

function toView(row: SubscriptionPlanRow): PlanView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    salesCapCents: row.salesCapCents,
    salesCap: row.salesCapCents === null ? null : row.salesCapCents / 100,
    priceCents: row.priceCents,
    price: row.priceCents / 100,
    sortOrder: row.sortOrder,
    active: row.active,
  };
}

/**
 * The plan catalog: five rungs priced by monthly sales, read from
 * `subscription_plans` rather than constants so the operator can re-price a
 * tier from the console without a deploy. Every quote and charge resolves a
 * plan through here.
 *
 * Cached in memory: the catalog is read on hot paths (every subscription view,
 * every coupon preview, every landing-page hit) but changes about never.
 * `updatePlan()` is the only writer, so it refreshes the cache directly; a
 * stale catalog can therefore only survive on another API instance, and only
 * until the TTL expires.
 */
@Injectable()
export class BillingSettingsService {
  private static readonly CACHE_TTL_MS = 60_000;
  private readonly logger = new Logger(BillingSettingsService.name);
  private cached: { plans: PlanView[]; at: number } | null = null;

  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  // ── Catalog ───────────────────────────────────────────────────

  /** Every plan, cheapest first — retired ones included. */
  async allPlans(): Promise<PlanView[]> {
    const now = Date.now();
    if (
      this.cached &&
      now - this.cached.at < BillingSettingsService.CACHE_TTL_MS
    ) {
      return this.cached.plans;
    }
    try {
      const rows = await this.db.query.subscriptionPlans.findMany({
        orderBy: [asc(subscriptionPlans.sortOrder)],
      });
      const plans = rows.length ? rows.map(toView) : FALLBACK_PLANS;
      this.cached = { plans, at: now };
      return plans;
    } catch (err) {
      // Never let a catalog read failure block a checkout — quote the seeded
      // ladder and let the next call retry.
      this.logger.error(
        `Falling back to the seeded plan ladder: ${String(err)}`,
      );
      return this.cached?.plans ?? FALLBACK_PLANS;
    }
  }

  /** The plans on sale, cheapest first — what a seller may pick. */
  async plans(): Promise<PlanView[]> {
    return (await this.allPlans()).filter((p) => p.active);
  }

  /**
   * One plan by code. Falls back to the entry plan for an unknown code so a
   * subscription pointing at a deleted rung still renders and still bills.
   */
  async planByCode(code: string | null | undefined): Promise<PlanView> {
    const all = await this.allPlans();
    return all.find((p) => p.code === code) ?? (await this.entryPlan());
  }

  /** The rung a shop lands on when it first subscribes (the cheapest one). */
  async entryPlan(): Promise<PlanView> {
    const sellable = await this.plans();
    return (
      sellable.find((p) => p.code === ENTRY_PLAN_CODE) ??
      sellable[0] ??
      FALLBACK_PLANS[0]
    );
  }

  /**
   * The next rung up from `code`, or null at the top of the ladder — what
   * auto-scale moves a shop onto when its sales reach the cap.
   */
  async nextPlanUp(code: string): Promise<PlanView | null> {
    const sellable = await this.plans();
    const current = sellable.find((p) => p.code === code);
    // A shop on a retired rung climbs to the cheapest sellable rung that is
    // dearer than what it pays today.
    const from = current?.sortOrder ?? -1;
    return sellable.find((p) => p.sortOrder > from) ?? null;
  }

  // ── Pricing (the entry price, quoted before a plan is picked) ──

  /**
   * The entry plan's price in paisa. This is what the landing page, the
   * create-shop wizard and every coupon preview quote, since a new shop
   * always starts on the entry rung.
   */
  async monthlyFeeCents(): Promise<number> {
    try {
      return (await this.entryPlan()).priceCents;
    } catch {
      return DEFAULT_MONTHLY_FEE_CENTS;
    }
  }

  async pricing(): Promise<PricingView> {
    const [plans, entry] = await Promise.all([this.plans(), this.entryPlan()]);
    return {
      monthlyFee: entry.priceCents / 100,
      monthlyFeeCents: entry.priceCents,
      currency: 'BDT',
      plans,
    };
  }

  // ── Operator edits ────────────────────────────────────────────

  /**
   * Re-price or re-cap one rung. Live subscriptions sitting on that rung are
   * re-priced in the same breath — the platform sells one ladder, so a shop
   * that signed up last month must not keep paying last month's price.
   * Cancelled subscriptions and recorded payments keep their historical
   * amounts.
   */
  async updatePlan(
    id: string,
    patch: {
      name?: string;
      priceCents?: number;
      salesCapCents?: number | null;
      active?: boolean;
    },
  ): Promise<PlanView> {
    const [row] = await this.db
      .update(subscriptionPlans)
      .set({
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.priceCents !== undefined && { priceCents: patch.priceCents }),
        ...(patch.salesCapCents !== undefined && {
          salesCapCents: patch.salesCapCents,
        }),
        ...(patch.active !== undefined && { active: patch.active }),
      })
      .where(eq(subscriptionPlans.id, id))
      .returning();
    if (!row) {
      throw new NotFoundException('Plan not found');
    }

    if (patch.priceCents !== undefined) {
      const cents = patch.priceCents;
      const repriced = await this.db
        .update(subscriptions)
        .set({
          amountCents: cents,
          // A coupon applied at the old price may out-discount the new one;
          // renewals charge amount - pending_discount, which must never go
          // negative. Clamping caps the coupon at "next month free".
          pendingDiscountCents: sql`LEAST(${subscriptions.pendingDiscountCents}, ${cents})`,
        })
        .where(
          and(
            eq(subscriptions.planCode, row.code),
            ne(subscriptions.status, 'cancelled'),
            ne(subscriptions.amountCents, cents),
          ),
        )
        .returning({ id: subscriptions.id });
      this.logger.log(
        `Plan ${row.code} priced at ${cents / 100} BDT; re-priced ${repriced.length} subscription(s)`,
      );
    }

    this.cached = null;
    return toView(row);
  }
}
