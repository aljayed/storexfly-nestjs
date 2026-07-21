import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { DEFAULT_MONTHLY_FEE_CENTS } from '../../common/constants/billing';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import { platformSettings, subscriptions } from '../../database/schema';

/** Bounds an operator typo can't escape: ৳1 … ৳100,000 per month. */
export const MIN_MONTHLY_FEE_CENTS = 100;
export const MAX_MONTHLY_FEE_CENTS = 10_000_000;

export interface PricingView {
  /** Monthly per-shop fee in whole taka, e.g. 599. */
  monthlyFee: number;
  monthlyFeeCents: number;
  currency: string;
}

/**
 * The platform's one price, read from the platform-settings singleton rather
 * than a constant so the operator can change it from the console without a
 * deploy. Every quote and charge goes through `monthlyFeeCents()`.
 *
 * Cached in memory: the fee is read on hot paths (every subscription view,
 * every coupon preview) but changes about never. `update()` is the only
 * writer, so it can refresh the cache directly; a stale value can therefore
 * only survive on another API instance, and only until the TTL expires.
 */
@Injectable()
export class BillingSettingsService {
  private static readonly CACHE_TTL_MS = 60_000;
  private readonly logger = new Logger(BillingSettingsService.name);
  private cached: { cents: number; at: number } | null = null;

  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  /** The live monthly fee in paisa. Falls back to the built-in default. */
  async monthlyFeeCents(): Promise<number> {
    const now = Date.now();
    if (
      this.cached &&
      now - this.cached.at < BillingSettingsService.CACHE_TTL_MS
    ) {
      return this.cached.cents;
    }
    try {
      const row = await this.db.query.platformSettings.findFirst({
        orderBy: [asc(platformSettings.id)],
        columns: { monthlyFeeCents: true },
      });
      const cents = row?.monthlyFeeCents ?? DEFAULT_MONTHLY_FEE_CENTS;
      this.cached = { cents, at: now };
      return cents;
    } catch (err) {
      // Never let a settings read failure block a checkout — quote the
      // default and let the next call retry.
      this.logger.error(
        `Falling back to the default monthly fee: ${String(err)}`,
      );
      return this.cached?.cents ?? DEFAULT_MONTHLY_FEE_CENTS;
    }
  }

  async pricing(): Promise<PricingView> {
    const cents = await this.monthlyFeeCents();
    return {
      monthlyFee: cents / 100,
      monthlyFeeCents: cents,
      currency: 'BDT',
    };
  }

  /**
   * Set the platform price. Live subscriptions are re-priced in the same
   * breath — the platform sells one plan, so a shop signed up last month must
   * not keep paying last month's price. Cancelled subscriptions and recorded
   * payments keep their historical amounts.
   */
  async update(cents: number): Promise<PricingView> {
    const row = await this.db.query.platformSettings.findFirst({
      orderBy: [asc(platformSettings.id)],
    });
    const id =
      row?.id ??
      (await this.db.insert(platformSettings).values({}).returning())[0].id;

    await this.db
      .update(platformSettings)
      .set({ monthlyFeeCents: cents })
      .where(eq(platformSettings.id, id));
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
          ne(subscriptions.status, 'cancelled'),
          ne(subscriptions.amountCents, cents),
        ),
      )
      .returning({ id: subscriptions.id });

    this.cached = { cents, at: Date.now() };
    this.logger.log(
      `Monthly fee set to ${cents / 100} BDT; re-priced ${repriced.length} subscription(s)`,
    );
    return this.pricing();
  }
}
