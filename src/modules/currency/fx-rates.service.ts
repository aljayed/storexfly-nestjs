import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import {
  BASE_DISPLAY_CURRENCY,
  DISPLAY_CURRENCIES,
} from '../../common/constants/display-currencies';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import { fxRates } from '../../database/schema';

export interface FxSnapshot {
  /** Units of each currency that one BDT buys. Always includes BDT: 1. */
  rates: Record<string, number>;
  fetchedAt: Date;
  source: string;
}

/** Providers publish once a day; four looks a day catches it promptly. */
const REFRESH_EVERY_MS = 6 * 60 * 60 * 1000;
/** After a failed refresh, try again sooner than the regular beat. */
const RETRY_EVERY_MS = 30 * 60 * 1000;
/**
 * Past this a snapshot is no longer offered at all. Three days rides out a
 * weekend of a provider being down; beyond it a quoted price has drifted far
 * enough that showing the shop's own currency is the more honest answer.
 */
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
/** A day-on-day move bigger than this is treated as a bad feed, not a market. */
const MAX_PLAUSIBLE_MOVE = 0.25;

type Provider = {
  name: string;
  url: string;
  /** Pull a { CODE: rate } map (base BDT) out of the provider's payload. */
  parse: (body: unknown) => Record<string, unknown> | null;
};

/**
 * Both are free, keyless and quote BDT directly. SSLCommerz was considered
 * first - it is already the card gateway - but it has no rate endpoint: it
 * only reports the rate it applied *after* a foreign-currency charge, which is
 * no use for pricing a catalogue.
 */
const PROVIDERS: Provider[] = [
  {
    name: 'open.er-api.com',
    url: `https://open.er-api.com/v6/latest/${BASE_DISPLAY_CURRENCY}`,
    parse: (body) => {
      const b = body as { result?: string; rates?: Record<string, unknown> };
      return b?.result === 'success' && b.rates ? b.rates : null;
    },
  },
  {
    name: 'fawazahmed0/currency-api',
    url: 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/bdt.min.json',
    parse: (body) => {
      const rates = (body as { bdt?: Record<string, unknown> })?.bdt;
      if (!rates) return null;
      return Object.fromEntries(
        Object.entries(rates).map(([k, v]) => [k.toUpperCase(), v]),
      );
    },
  },
];

/**
 * Keep only the currencies we display, and only sane numbers. Returns null
 * unless every display currency is present - a partial table would leave some
 * visitors converted and others not, for no reason they could see.
 */
export function cleanRates(
  raw: Record<string, unknown>,
): Record<string, number> | null {
  const out: Record<string, number> = {};
  for (const code of DISPLAY_CURRENCIES) {
    const v = code === BASE_DISPLAY_CURRENCY ? 1 : Number(raw[code]);
    if (!Number.isFinite(v) || v <= 0) return null;
    out[code] = v;
  }
  return out;
}

/** True when `next` moved implausibly far from `prev` for any major currency. */
export function looksWrong(
  prev: Record<string, number>,
  next: Record<string, number>,
): boolean {
  return ['USD', 'EUR', 'GBP', 'INR'].some((code) => {
    const a = prev[code];
    const b = next[code];
    return !!a && !!b && Math.abs(b - a) / a > MAX_PLAUSIBLE_MOVE;
  });
}

/**
 * Exchange rates for showing prices in a visitor's currency.
 *
 * Read from memory on every request; refreshed in the background from a free
 * provider with a second one behind it, and mirrored to the database so a
 * restart starts warm. When nothing fresh enough is on hand, `current()` is
 * null and the storefront shows each shop's own currency instead.
 */
@Injectable()
export class FxRatesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FxRatesService.name);
  private snapshot: FxSnapshot | null = null;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async onModuleInit(): Promise<void> {
    try {
      const [row] = await this.db
        .select()
        .from(fxRates)
        .where(eq(fxRates.base, BASE_DISPLAY_CURRENCY));
      const rates = row ? cleanRates(row.rates) : null;
      if (row && rates) {
        this.snapshot = { rates, fetchedAt: row.fetchedAt, source: row.source };
      }
    } catch (err) {
      this.logger.warn(`Could not load stored rates: ${String(err)}`);
    }
    const age = this.snapshot
      ? Date.now() - this.snapshot.fetchedAt.getTime()
      : Infinity;
    // Never block boot on a third party: refresh in the background.
    this.schedule(age >= REFRESH_EVERY_MS ? 0 : REFRESH_EVERY_MS - age);
  }

  onModuleDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  /** The rates to quote with, or null when none are fresh enough to trust. */
  current(): FxSnapshot | null {
    const s = this.snapshot;
    if (!s || Date.now() - s.fetchedAt.getTime() > MAX_AGE_MS) return null;
    return s;
  }

  private schedule(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.refresh().then((ok) =>
        this.schedule(ok ? REFRESH_EVERY_MS : RETRY_EVERY_MS),
      );
    }, delayMs);
    this.timer.unref?.();
  }

  /** Fetch a new snapshot. Returns whether one was accepted. */
  async refresh(): Promise<boolean> {
    const prev = this.snapshot;
    let suspect: { rates: Record<string, number>; source: string } | null =
      null;

    for (const provider of PROVIDERS) {
      const rates = await this.fetchFrom(provider);
      if (!rates) continue;
      if (prev && looksWrong(prev.rates, rates)) {
        // One provider disagreeing wildly with yesterday is a bad feed. Two
        // providers agreeing with each other is the market having moved.
        if (suspect && !looksWrong(suspect.rates, rates)) {
          return this.accept(rates, provider.name);
        }
        this.logger.warn(
          `${provider.name} moved >${MAX_PLAUSIBLE_MOVE * 100}% from the stored rates; seeking a second opinion`,
        );
        suspect ??= { rates, source: provider.name };
        continue;
      }
      return this.accept(rates, provider.name);
    }
    this.logger.warn('No exchange-rate provider returned usable rates');
    return false;
  }

  private async accept(
    rates: Record<string, number>,
    source: string,
  ): Promise<boolean> {
    const fetchedAt = new Date();
    this.snapshot = { rates, fetchedAt, source };
    try {
      await this.db
        .insert(fxRates)
        .values({ base: BASE_DISPLAY_CURRENCY, rates, source, fetchedAt })
        .onConflictDoUpdate({
          target: fxRates.base,
          set: { rates, source, fetchedAt },
        });
    } catch (err) {
      // Memory still has it; only the warm start after a restart is lost.
      this.logger.warn(`Could not store rates: ${String(err)}`);
    }
    this.logger.log(`Exchange rates refreshed from ${source}`);
    return true;
  }

  private async fetchFrom(
    provider: Provider,
  ): Promise<Record<string, number> | null> {
    try {
      const res = await fetch(provider.url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = provider.parse(await res.json());
      const rates = raw ? cleanRates(raw) : null;
      if (!rates) throw new Error('payload missing display currencies');
      return rates;
    } catch (err) {
      this.logger.warn(`${provider.name} failed: ${String(err)}`);
      return null;
    }
  }
}
