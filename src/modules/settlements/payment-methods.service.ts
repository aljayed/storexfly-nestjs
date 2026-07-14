import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import {
  orders,
  paymentMethods,
  platformSettings,
} from '../../database/schema';
import type { PaymentMethodRow } from '../../database/schema';
import { CARD_FEE_BP, MBANK_FEE_BP } from './settlement.constants';

/** Online (fee-carrying) method kinds an operator can add. */
export type OnlineMethodKind = 'mbank' | 'card';

export interface PaymentMethodView {
  id: string;
  code: string;
  kind: 'mbank' | 'card' | 'cod';
  title: string;
  subtitle: string | null;
  feePercent: number;
  locked: boolean;
}

/**
 * The checkout payment methods, managed from the platform-admin console.
 * Checkout, the item form and all settlement math read the catalog through
 * here, so an operator's change is live everywhere immediately. COD is a
 * locked row: always present, always enabled, always fee-free. Deleting a
 * method that historical orders reference merely disables it, so those
 * orders keep settling with the fee rate they were sold under.
 */
@Injectable()
export class PaymentMethodsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  /** Buyer/seller-facing catalog: enabled methods in display order. */
  async listEnabled(): Promise<PaymentMethodView[]> {
    const rows = await this.ensureSeeded();
    return rows.filter((m) => m.enabled).map(view);
  }

  /** Every method (disabled included), keyed by code — for settlement math. */
  async byCode(): Promise<Map<string, PaymentMethodRow>> {
    const rows = await this.ensureSeeded();
    return new Map(rows.map((m) => [m.code, m]));
  }

  async findEnabledByCode(code: string): Promise<PaymentMethodRow | undefined> {
    const rows = await this.ensureSeeded();
    return rows.find((m) => m.code === code && m.enabled);
  }

  async create(input: {
    kind: OnlineMethodKind;
    title: string;
    subtitle?: string;
    feePercent: number;
  }): Promise<PaymentMethodView> {
    const rows = await this.ensureSeeded();
    const title = input.title.trim();
    if (!title) throw new BadRequestException('Enter a name for the method.');

    const code = uniqueCode(title, rows);
    const maxSort = Math.max(0, ...rows.map((m) => m.sortOrder));
    const [row] = await this.db
      .insert(paymentMethods)
      .values({
        code,
        kind: input.kind,
        title,
        subtitle: input.subtitle?.trim() || null,
        feeBp: toBp(input.feePercent),
        sortOrder: maxSort + 1,
      })
      .returning();
    return view(row);
  }

  async update(
    id: string,
    patch: { title?: string; subtitle?: string | null; feePercent?: number },
  ): Promise<PaymentMethodView> {
    const row = await this.requireById(id);
    const set: Partial<PaymentMethodRow> = {};
    if (patch.title !== undefined) {
      const title = patch.title.trim();
      if (!title) throw new BadRequestException('The name cannot be empty.');
      set.title = title;
    }
    if (patch.subtitle !== undefined) {
      set.subtitle = patch.subtitle?.trim() || null;
    }
    if (patch.feePercent !== undefined) {
      if (row.locked && toBp(patch.feePercent) !== 0) {
        throw new BadRequestException('Cash on Delivery is always free.');
      }
      set.feeBp = row.locked ? 0 : toBp(patch.feePercent);
    }
    const [updated] = await this.db
      .update(paymentMethods)
      .set(set)
      .where(eq(paymentMethods.id, id))
      .returning();
    return view(updated);
  }

  /**
   * Removes a method from checkout. Hard-deletes when no order ever used it;
   * otherwise disables it so settlement history keeps its title and fee rate.
   */
  async remove(id: string): Promise<{ archived: boolean }> {
    const row = await this.requireById(id);
    if (row.locked) {
      throw new ConflictException(
        'Cash on Delivery is built in and cannot be removed.',
      );
    }
    const [{ used }] = await this.db
      .select({ used: sql<number>`count(*)::int` })
      .from(orders)
      .where(eq(orders.paymentMethod, row.code));
    if (used > 0) {
      await this.db
        .update(paymentMethods)
        .set({ enabled: false })
        .where(eq(paymentMethods.id, id));
      return { archived: true };
    }
    await this.db.delete(paymentMethods).where(eq(paymentMethods.id, id));
    return { archived: false };
  }

  /* ── Settlement info banner ────────────────────────────────────── */

  async getBanner(): Promise<string | null> {
    const [row] = await this.db
      .select({ banner: platformSettings.settlementBanner })
      .from(platformSettings)
      .orderBy(asc(platformSettings.id))
      .limit(1);
    return row?.banner?.trim() || null;
  }

  async setBanner(banner: string | null): Promise<string | null> {
    const value = banner?.trim() || null;
    const [existing] = await this.db
      .select({ id: platformSettings.id })
      .from(platformSettings)
      .orderBy(asc(platformSettings.id))
      .limit(1);
    if (existing) {
      await this.db
        .update(platformSettings)
        .set({ settlementBanner: value })
        .where(eq(platformSettings.id, existing.id));
    } else {
      await this.db
        .insert(platformSettings)
        .values({ settlementBanner: value });
    }
    return value;
  }

  /* ── Internals ─────────────────────────────────────────────────── */

  private async requireById(id: string): Promise<PaymentMethodRow> {
    const row = await this.db.query.paymentMethods.findFirst({
      where: eq(paymentMethods.id, id),
    });
    if (!row) throw new NotFoundException('Payment method not found');
    return row;
  }

  /**
   * All rows in display order, seeding the three defaults on first use — a
   * fresh `db:push` database has the table but not the migration's seed rows.
   */
  private async ensureSeeded(): Promise<PaymentMethodRow[]> {
    const rows = await this.db.query.paymentMethods.findMany({
      orderBy: [asc(paymentMethods.sortOrder), asc(paymentMethods.createdAt)],
    });
    if (rows.some((m) => m.kind === 'cod')) return rows;
    await this.db
      .insert(paymentMethods)
      .values([
        {
          code: 'cod',
          kind: 'cod',
          title: 'Cash on Delivery',
          subtitle: 'Pay when your order arrives',
          feeBp: 0,
          locked: true,
          sortOrder: 0,
        },
        {
          code: 'mbank',
          kind: 'mbank',
          title: 'Mobile banking',
          subtitle: 'bKash · Nagad · Rocket',
          feeBp: MBANK_FEE_BP,
          sortOrder: 1,
        },
        {
          code: 'card',
          kind: 'card',
          title: 'Card',
          subtitle: 'Visa · Mastercard — via SSLCommerz',
          feeBp: CARD_FEE_BP,
          sortOrder: 2,
        },
      ])
      .onConflictDoNothing();
    return this.db.query.paymentMethods.findMany({
      orderBy: [asc(paymentMethods.sortOrder), asc(paymentMethods.createdAt)],
    });
  }
}

function toBp(percent: number): number {
  return Math.round(percent * 100);
}

/** Slugifies the title into a code, suffixing to dodge collisions. */
function uniqueCode(title: string, rows: PaymentMethodRow[]): string {
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'method';
  const taken = new Set(rows.map((m) => m.code));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function view(m: PaymentMethodRow): PaymentMethodView {
  return {
    id: m.id,
    code: m.code,
    kind: m.kind,
    title: m.title,
    subtitle: m.subtitle,
    feePercent: m.feeBp / 100,
    locked: m.locked,
  };
}
