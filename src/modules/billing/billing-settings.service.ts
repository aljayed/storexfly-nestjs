import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, asc, eq, ne } from 'drizzle-orm';
import {
  COMMISSION_BPS,
  CREDIT_BALANCE_CAP_CENTS,
  CREDIT_PACKS,
  ENTRY_PACK_CODE,
  PLATFORM_CURRENCY,
} from '../../common/constants/billing';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import {
  creditPacks,
  platformSettings,
  subscriptions,
  type CreditPackRow,
} from '../../database/schema';

/** Bounds an operator typo can't escape: ৳1 … ৳1,00,000 for one pack. */
export const MIN_PACK_PRICE_CENTS = 100;
export const MAX_PACK_PRICE_CENTS = 10_000_000;

/** Bounds on the selling a pack pays for: ৳1,000 … ৳100 crore. */
export const MIN_SALES_CREDIT_CENTS = 100_000;
export const MAX_SALES_CREDIT_CENTS = 100_000_000_000;

/** Bounds on the verified track's rate: 0.01% … 30%, in basis points. */
export const MIN_COMMISSION_BPS = 1;
export const MAX_COMMISSION_BPS = 3_000;

/** One pack on the shelf, as the console and the landing page read it. */
export interface CreditPackView {
  id: string;
  code: string;
  name: string;
  /** Selling this pack pays for, in paisa. */
  salesCreditCents: number;
  /** Selling this pack pays for, in whole taka, e.g. 100000. */
  salesCredit: number;
  priceCents: number;
  /** What the pack costs in whole taka, e.g. 1899. */
  price: number;
  /**
   * The pack as a share of the sales it covers, e.g. 1.9 for ৳1,899 per
   * ৳1,00,000 - the number a seller weighs against the commission rate.
   */
  ratePct: number;
  badge: string | null;
  sortOrder: number;
  active: boolean;
}

export interface PricingView {
  currency: string;
  /** The verified track's rate as a percentage, e.g. 1.5. */
  commissionPct: number;
  commissionBps: number;
  /** The most credit a shop may hold at once, in paisa and in taka. */
  creditCapCents: number;
  creditCap: number;
  /** The packs on sale, cheapest first. */
  packs: CreditPackView[];
  /** The cheapest pack - what "from ৳X" quotes. */
  entryPack: CreditPackView | null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function toView(row: CreditPackRow): CreditPackView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    salesCreditCents: row.salesCreditCents,
    salesCredit: row.salesCreditCents / 100,
    priceCents: row.priceCents,
    price: row.priceCents / 100,
    ratePct: round2((row.priceCents / row.salesCreditCents) * 100),
    badge: row.badge,
    sortOrder: row.sortOrder,
    active: row.active,
  };
}

/** The seeded shelf, used when the catalogue table can't be read. */
const FALLBACK_PACKS: CreditPackView[] = CREDIT_PACKS.map((seed, i) =>
  toView({
    id: seed.code,
    code: seed.code,
    name: seed.name,
    salesCreditCents: seed.salesCreditCents,
    priceCents: seed.priceCents,
    badge: seed.badge ?? null,
    sortOrder: i + 1,
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  }),
);

/**
 * The credit-pack catalogue and the commission rate - everything the platform
 * charges for. Read from `credit_packs` rather than constants so the operator
 * can re-price a pack from the console without a deploy; every quote and
 * every charge resolves a pack through here.
 *
 * Cached in memory: the catalogue is read on hot paths (every subscription
 * view, every coupon preview, every landing-page hit) but changes about never.
 * `updatePack()` is the only writer, so it clears the cache directly; a stale
 * catalogue can therefore only survive on another API instance, and only until
 * the TTL expires.
 */
@Injectable()
export class BillingSettingsService {
  private static readonly CACHE_TTL_MS = 60_000;
  private readonly logger = new Logger(BillingSettingsService.name);
  private cached: { packs: CreditPackView[]; at: number } | null = null;
  private cachedRate: { bps: number; at: number } | null = null;

  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  // ── Catalogue ─────────────────────────────────────────────────

  /** Every pack, cheapest first - retired ones included. */
  async allPacks(): Promise<CreditPackView[]> {
    const now = Date.now();
    if (
      this.cached &&
      now - this.cached.at < BillingSettingsService.CACHE_TTL_MS
    ) {
      return this.cached.packs;
    }
    try {
      const rows = await this.db.query.creditPacks.findMany({
        orderBy: [asc(creditPacks.sortOrder)],
      });
      const packs = rows.length ? rows.map(toView) : FALLBACK_PACKS;
      this.cached = { packs, at: now };
      return packs;
    } catch (err) {
      // Never let a catalogue read failure block a purchase - quote the
      // seeded shelf and let the next call retry.
      this.logger.error(
        `Falling back to the seeded credit packs: ${String(err)}`,
      );
      return this.cached?.packs ?? FALLBACK_PACKS;
    }
  }

  /** The packs on sale, cheapest first - what a seller may buy. */
  async packs(): Promise<CreditPackView[]> {
    return (await this.allPacks()).filter((p) => p.active);
  }

  /** One pack by code, or null when the code names nothing on sale. */
  async packByCode(
    code: string | null | undefined,
  ): Promise<CreditPackView | null> {
    if (!code) {
      return null;
    }
    return (await this.allPacks()).find((p) => p.code === code) ?? null;
  }

  /** The cheapest pack on sale - what "from ৳X" quotes. */
  async entryPack(): Promise<CreditPackView | null> {
    const sellable = await this.packs();
    return (
      sellable.find((p) => p.code === ENTRY_PACK_CODE) ??
      sellable[0] ??
      FALLBACK_PACKS[0] ??
      null
    );
  }

  // ── The verified track's rate ─────────────────────────────────

  /**
   * What a verified merchant pays on the post-paid track, in basis points.
   * Operator-set on the platform_settings singleton; `COMMISSION_BPS` is only
   * the seed and the read-failure fallback, so a settings hiccup quotes the
   * launch rate rather than breaking a page or a bill.
   */
  async commissionBps(): Promise<number> {
    const now = Date.now();
    if (
      this.cachedRate &&
      now - this.cachedRate.at < BillingSettingsService.CACHE_TTL_MS
    ) {
      return this.cachedRate.bps;
    }
    try {
      const row = await this.db.query.platformSettings.findFirst({
        orderBy: [asc(platformSettings.id)],
        columns: { commissionBps: true },
      });
      const bps = row?.commissionBps ?? COMMISSION_BPS;
      this.cachedRate = { bps, at: now };
      return bps;
    } catch (err) {
      this.logger.error(
        `Falling back to the seeded commission rate: ${String(err)}`,
      );
      return this.cachedRate?.bps ?? COMMISSION_BPS;
    }
  }

  // ── Pricing (what the landing page and the console quote) ──────

  async pricing(): Promise<PricingView> {
    const [packs, entryPack, bps] = await Promise.all([
      this.packs(),
      this.entryPack(),
      this.commissionBps(),
    ]);
    return {
      currency: PLATFORM_CURRENCY,
      commissionPct: bps / 100,
      commissionBps: bps,
      creditCapCents: CREDIT_BALANCE_CAP_CENTS,
      creditCap: CREDIT_BALANCE_CAP_CENTS / 100,
      packs,
      entryPack,
    };
  }

  // ── Operator edits ────────────────────────────────────────────

  /**
   * Re-price a pack, change how much selling it buys, or retire it. Nothing
   * already sold is touched: credit a seller bought is theirs at the price
   * they paid, and the ledger keeps its historical amounts. Only what is on
   * the shelf from here on changes.
   */
  async updatePack(
    id: string,
    patch: {
      name?: string;
      priceCents?: number;
      salesCreditCents?: number;
      badge?: string | null;
      active?: boolean;
    },
  ): Promise<CreditPackView> {
    const [row] = await this.db
      .update(creditPacks)
      .set({
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.priceCents !== undefined && { priceCents: patch.priceCents }),
        ...(patch.salesCreditCents !== undefined && {
          salesCreditCents: patch.salesCreditCents,
        }),
        ...(patch.badge !== undefined && { badge: patch.badge }),
        ...(patch.active !== undefined && { active: patch.active }),
      })
      .where(eq(creditPacks.id, id))
      .returning();
    if (!row) {
      throw new NotFoundException('Credit pack not found');
    }
    this.logger.log(
      `Credit pack ${row.code}: ${row.salesCreditCents / 100} BDT of selling for ${row.priceCents / 100} BDT`,
    );
    this.cached = null;
    return toView(row);
  }

  /**
   * Set the verified track's rate. The platform runs one rate, so every shop
   * currently on the post-paid track is moved to it in the same breath -
   * otherwise a merchant who verified last month would keep being billed at a
   * rate the platform no longer offers.
   *
   * Note this reaches into the month already in progress: a shop billed on the
   * 12th is billed for that whole month at the new rate, days already sold
   * included. The console says so, because it is the operator's call.
   */
  async updateCommissionBps(bps: number): Promise<number> {
    const settings = await this.db.query.platformSettings.findFirst({
      orderBy: [asc(platformSettings.id)],
      columns: { id: true },
    });
    if (!settings) {
      throw new NotFoundException('Platform settings row not found');
    }
    await this.db
      .update(platformSettings)
      .set({ commissionBps: bps })
      .where(eq(platformSettings.id, settings.id));

    const rerated = await this.db
      .update(subscriptions)
      .set({ commissionBps: bps })
      .where(
        and(
          eq(subscriptions.billingMode, 'commission'),
          ne(subscriptions.status, 'cancelled'),
          ne(subscriptions.commissionBps, bps),
        ),
      )
      .returning({ id: subscriptions.id });
    this.logger.log(
      `Commission rate set to ${bps / 100}%; re-rated ${rerated.length} verified shop(s)`,
    );

    this.cachedRate = null;
    return bps;
  }
}
