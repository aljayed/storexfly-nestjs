import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { asc, eq, isNull, and } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import { paymentMethods, platformSettings } from '../../database/schema';
import type { PaymentMethodRow } from '../../database/schema';
import { SERVICE_FEE_BP } from '../../common/constants/billing';
import { GatewaySettingsService } from '../gateways/gateway-settings.service';

/** Online (fee-carrying) method kinds an operator can add. */
export type OnlineMethodKind = 'mbank' | 'card';

/**
 * Which gateway collects a method's money. 'none' is trust-based - COD, or a
 * direct transfer to the seller's own number that the platform never holds.
 */
export type PaymentGatewayChoice = 'none' | 'bkash' | 'sslcommerz';

export interface PaymentMethodView {
  id: string;
  code: string;
  kind: 'mbank' | 'card' | 'cod';
  title: string;
  subtitle: string | null;
  /**
   * true = checkout draws the brand marks the method accepts (Visa,
   * Mastercard, Amex, bKash, Nagad...) where the subtitle would go; false =
   * it prints the `subtitle` wording. Methods with no artwork for their
   * kind - Cash on Delivery - show the wording either way.
   */
  subtitleIcons: boolean;
  feePercent: number;
  locked: boolean;
  /** Anything but 'none' = platform-collected via that gateway. */
  gateway: PaymentGatewayChoice;
  /**
   * Off = the method exists but is offered nowhere: it vanishes from
   * checkout, from the product-level payment toggles and from anywhere a
   * buyer could pick it. Orders that already used it keep settling on its
   * fee rate, which is why disabling is not deleting.
   */
  enabled: boolean;
}

/**
 * The checkout payment methods, managed from the platform-admin console.
 * Checkout, the item form and all settlement math read the catalog through
 * here, so an operator's change is live everywhere immediately. COD is a
 * locked row: always present, always enabled, always fee-free. Removed methods
 * remain in the accounting catalog, and collection routes are immutable so
 * changing checkout configuration cannot reclassify past receipts.
 */
@Injectable()
export class PaymentMethodsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly gateways: GatewaySettingsService,
  ) {}

  /** Buyer/seller-facing catalog: enabled methods in display order. */
  async listEnabled(): Promise<PaymentMethodView[]> {
    const rows = await this.ensureSeeded();
    const gateways = await this.gateways.view();
    return rows
      .filter(
        (m) =>
          m.enabled &&
          !m.archivedAt &&
          (m.gateway === 'none' ||
            (gateways[m.gateway].enabled && gateways[m.gateway].configured)),
      )
      .map(view);
  }

  /**
   * Operator-facing catalog: unarchived methods, switched off ones included. The
   * console is the one place that has to see a disabled method - it is what
   * you switch back on.
   */
  async listAll(): Promise<PaymentMethodView[]> {
    return (await this.ensureSeeded()).filter((m) => !m.archivedAt).map(view);
  }

  /** Every method (disabled and archived included), keyed by code for accounting. */
  async byCode(): Promise<Map<string, PaymentMethodRow>> {
    const rows = await this.ensureSeeded();
    return new Map(
      rows.map((m) => [
        m.code,
        { ...m, feeBp: m.gateway === 'none' ? 0 : SERVICE_FEE_BP },
      ]),
    );
  }

  async findEnabledByCode(code: string): Promise<PaymentMethodRow | undefined> {
    const rows = await this.ensureSeeded();
    return rows.find((m) => m.code === code && m.enabled && !m.archivedAt);
  }

  async create(input: {
    kind: OnlineMethodKind;
    title: string;
    subtitle?: string;
    subtitleIcons?: boolean;
    feePercent?: number;
    gateway?: PaymentGatewayChoice;
    enabled?: boolean;
  }): Promise<PaymentMethodView> {
    const rows = await this.ensureSeeded();
    const title = input.title.trim();
    if (!title) throw new BadRequestException('Enter a name for the method.');

    const gateway = input.gateway ?? 'none';
    validateGatewayKind(input.kind, gateway);
    const feeBp = processingFee(gateway, input.feePercent);
    // The unique index arbitrates concurrent creates with the same title.
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = attempt === 0 ? rows : await this.ensureSeeded();
      const [row] = await this.db
        .insert(paymentMethods)
        .values({
          code: uniqueCode(title, current),
          kind: input.kind,
          title,
          subtitle: input.subtitle?.trim() || null,
          subtitleIcons: input.subtitleIcons ?? true,
          gateway,
          enabled: input.enabled ?? true,
          feeBp,
          sortOrder: Math.max(0, ...current.map((m) => m.sortOrder)) + 1,
        })
        .onConflictDoNothing({ target: paymentMethods.code })
        .returning();
      if (row) return view(row);
    }
    throw new ConflictException(
      'Another method was added at the same time. Please try again.',
    );
  }

  async update(
    id: string,
    patch: {
      title?: string;
      subtitle?: string | null;
      subtitleIcons?: boolean;
      feePercent?: number;
      gateway?: PaymentGatewayChoice;
      enabled?: boolean;
    },
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
    if (patch.subtitleIcons !== undefined) {
      set.subtitleIcons = patch.subtitleIcons;
    }
    if (patch.enabled !== undefined) {
      // COD is the floor under every shop: there is always one way to buy
      // that needs no gateway, no card and no wallet. Switching it off would
      // leave a shop with no configured gateway unable to sell at all.
      if ((row.locked || row.kind === 'cod') && !patch.enabled) {
        throw new BadRequestException(
          'Cash on Delivery is built in and cannot be switched off.',
        );
      }
      set.enabled = patch.enabled;
    }
    // Orders store the method code, so changing its collector would reclassify
    // existing receipts and unpaid settlements. A different route needs a new code.
    if (patch.gateway !== undefined && patch.gateway !== row.gateway) {
      throw new BadRequestException(
        'Money collection cannot change on an existing method. Add a new method to preserve payment and settlement history.',
      );
    }
    set.feeBp = processingFee(row.gateway, patch.feePercent);
    const [updated] = await this.db
      .update(paymentMethods)
      .set(set)
      .where(and(eq(paymentMethods.id, id), isNull(paymentMethods.archivedAt)))
      .returning();
    if (!updated)
      throw new NotFoundException(
        'Payment method was removed. Refresh the list.',
      );
    return view(updated);
  }

  /** Archive without deleting or reusing a code an in-flight checkout may hold. */
  async remove(id: string): Promise<{ archived: boolean }> {
    const row = await this.requireById(id);
    if (row.locked || row.kind === 'cod') {
      throw new ConflictException(
        'Cash on Delivery is built in and cannot be removed.',
      );
    }
    await this.db
      .update(paymentMethods)
      .set({ enabled: false, archivedAt: new Date() })
      .where(eq(paymentMethods.id, id));
    return { archived: true };
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
    if (!row || row.archivedAt)
      throw new NotFoundException('Payment method not found');
    return row;
  }

  /**
   * All rows in display order, seeding the three defaults on first use - a
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
          feeBp: 0,
          sortOrder: 1,
        },
        {
          code: 'card',
          kind: 'card',
          title: 'Card',
          subtitle: 'Visa · Mastercard - via SSLCommerz',
          feeBp: 0,
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
    subtitleIcons: m.subtitleIcons,
    feePercent: m.gateway === 'none' ? 0 : SERVICE_FEE_BP / 100,
    locked: m.locked,
    gateway: m.gateway,
    enabled: m.enabled,
  };
}

function validateGatewayKind(
  kind: OnlineMethodKind,
  gateway: PaymentGatewayChoice,
): void {
  if (kind === 'card' && gateway === 'bkash') {
    throw new BadRequestException(
      'bKash is a mobile banking gateway. Use SSLCommerz for a card method.',
    );
  }
}

function processingFee(
  gateway: PaymentGatewayChoice,
  percent?: number,
): number {
  const expected = gateway === 'none' ? 0 : SERVICE_FEE_BP;
  if (
    percent !== undefined &&
    (!Number.isFinite(percent) || toBp(percent) !== expected)
  ) {
    throw new BadRequestException(
      gateway === 'none'
        ? 'Direct collection and Cash on Delivery have no processing fee.'
        : `Online payment processing is fixed at ${SERVICE_FEE_BP / 100}%.`,
    );
  }
  return expected;
}
