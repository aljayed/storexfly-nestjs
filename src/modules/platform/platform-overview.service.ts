import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, count, desc, eq, gte, ilike, ne, or, sql } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import type { KycStatus } from '../../database/schema/enums';
import { customers, orders, shops } from '../../database/schema';
import type { ShopRow } from '../../database/schema';
import { PlatformCustomerListResponse } from './dto/platform-customer.response';
import {
  KycStatusFilter,
  PlatformKycQueryDto,
} from './dto/platform-kyc-query.dto';
import {
  PlatformKycDetailResponse,
  PlatformKycListResponse,
  PlatformKycResponse,
} from './dto/platform-kyc.response';
import { PlatformShopListResponse } from './dto/platform-shop.response';

/** Cents → major units (e.g. 18420_00 → 18420). */
const toMajor = (cents: number) => Math.round(cents) / 100;

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Read-only aggregates for the platform-admin console: every shop on the
 * platform (with owner contact + recent sales) and every buyer across all
 * shops. Operator-scoped - never filtered to a single shop.
 */
@Injectable()
export class PlatformOverviewService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  /** Paginated list of all shops with owner contact and last-30-day sales. */
  async listShops(query: {
    q?: string;
    page: number;
    limit: number;
    offset: number;
  }): Promise<PlatformShopListResponse> {
    const q = query.q?.trim();
    const where = q
      ? or(ilike(shops.name, `%${q}%`), ilike(shops.handle, `%${q}%`))
      : undefined;

    const since = new Date(Date.now() - THIRTY_DAYS_MS);

    const [rows, [{ total }], salesRows] = await Promise.all([
      this.db.query.shops.findMany({
        where,
        orderBy: [desc(shops.createdAt)],
        limit: query.limit,
        offset: query.offset,
        with: { owner: { columns: { name: true, email: true, phone: true } } },
      }),
      this.db.select({ total: count() }).from(shops).where(where),
      // Last-30-day paid sales, grouped per shop in one pass.
      this.db
        .select({
          shopId: orders.shopId,
          cents: sql<string>`coalesce(sum(${orders.totalCents}), 0)`,
          n: count(),
        })
        .from(orders)
        .where(and(eq(orders.pay, 'Paid'), gte(orders.placedAt, since)))
        .groupBy(orders.shopId),
    ]);

    const sales = new Map(
      salesRows.map((r) => [r.shopId, { cents: Number(r.cents), n: r.n }]),
    );

    return {
      data: rows.map((s) => {
        const agg = sales.get(s.id);
        return {
          id: s.id,
          name: s.name,
          handle: s.handle,
          ownerName: s.owner?.name ?? '-',
          email: s.owner?.email ?? undefined,
          phone: s.owner?.phone ?? s.supportPhone ?? undefined,
          currency: s.currency,
          live: s.live,
          sales30d: toMajor(agg?.cents ?? 0),
          orders30d: agg?.n ?? 0,
          createdAt: s.createdAt.toISOString(),
        };
      }),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  /** Paginated list of all buyers across every shop. */
  async listCustomers(query: {
    q?: string;
    page: number;
    limit: number;
    offset: number;
  }): Promise<PlatformCustomerListResponse> {
    const q = query.q?.trim();
    const where = q
      ? or(ilike(customers.name, `%${q}%`), ilike(customers.email, `%${q}%`))
      : undefined;

    const [rows, [{ total }]] = await Promise.all([
      this.db.query.customers.findMany({
        where,
        orderBy: [desc(customers.spentCents)],
        limit: query.limit,
        offset: query.offset,
        with: {
          shop: { columns: { name: true, handle: true, currency: true } },
        },
      }),
      this.db.select({ total: count() }).from(customers).where(where),
    ]);

    return {
      data: rows.map((c) => ({
        id: c.id,
        name: c.name,
        email: c.email,
        city: c.city,
        segment: c.segment,
        ordersCount: c.ordersCount,
        spent: toMajor(c.spentCents),
        shopName: c.shop?.name ?? '-',
        shopHandle: c.shop?.handle ?? '',
        currency: c.shop?.currency ?? 'BDT',
        createdAt: c.createdAt.toISOString(),
      })),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  /**
   * The KYC review queue: shops with a submitted business verification, with
   * owner contact and the licence details (but not the document - that's served
   * per-shop by {@link getKyc}). Defaults to every submitted shop; `pending`
   * always sorts first so the work to do is at the top.
   */
  async listKyc(query: PlatformKycQueryDto): Promise<PlatformKycListResponse> {
    const q = query.q?.trim();
    const status = query.status ?? 'all';

    // 'all' means every shop that has actually submitted something - an
    // unsubmitted shop has nothing to review, so it's hidden unless asked for.
    const statusWhere =
      status === 'all'
        ? ne(shops.kycStatus, 'unsubmitted')
        : eq(shops.kycStatus, status);
    const search = q
      ? or(
          ilike(shops.name, `%${q}%`),
          ilike(shops.handle, `%${q}%`),
          ilike(shops.kycLegalName, `%${q}%`),
        )
      : undefined;
    const where = search ? and(statusWhere, search) : statusWhere;

    const [rows, [{ total }], countRows] = await Promise.all([
      this.db.query.shops.findMany({
        where,
        // Pending first, then most-recently submitted.
        orderBy: [
          sql`(${shops.kycStatus} = 'pending') desc`,
          desc(shops.kycSubmittedAt),
        ],
        limit: query.limit,
        offset: query.offset,
        with: { owner: { columns: { name: true, email: true, phone: true } } },
      }),
      this.db.select({ total: count() }).from(shops).where(where),
      // Queue tallies for the status tabs (independent of the active filter).
      this.db
        .select({ status: shops.kycStatus, n: count() })
        .from(shops)
        .groupBy(shops.kycStatus),
    ]);

    const byStatus = new Map(countRows.map((r) => [r.status, r.n]));

    return {
      data: rows.map((s) => this.toKycResponse(s)),
      counts: {
        pending: byStatus.get('pending') ?? 0,
        verified: byStatus.get('verified') ?? 0,
        rejected: byStatus.get('rejected') ?? 0,
      },
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  /** Full KYC record for one shop, including the trade-licence document. */
  async getKyc(shopId: string): Promise<PlatformKycDetailResponse> {
    const shop = await this.db.query.shops.findFirst({
      where: eq(shops.id, shopId),
      with: { owner: { columns: { name: true, email: true, phone: true } } },
    });
    if (!shop) throw new NotFoundException('Shop not found');
    return {
      ...this.toKycResponse(shop),
      document: shop.kycDocument ?? undefined,
    };
  }

  /** Operator verdict: move a submission to 'verified' or 'rejected'. */
  async decideKyc(
    shopId: string,
    status: 'verified' | 'rejected',
  ): Promise<PlatformKycDetailResponse> {
    const [row] = await this.db
      .update(shops)
      .set({ kycStatus: status })
      .where(eq(shops.id, shopId))
      .returning({ id: shops.id });
    if (!row) throw new NotFoundException('Shop not found');
    return this.getKyc(shopId);
  }

  private toKycResponse(
    s: ShopRow & {
      owner?: {
        name: string | null;
        email: string | null;
        phone: string | null;
      } | null;
    },
  ): PlatformKycResponse {
    return {
      shopId: s.id,
      shopName: s.name,
      shopHandle: s.handle,
      ownerName: s.owner?.name ?? '-',
      ownerEmail: s.owner?.email ?? undefined,
      ownerPhone: s.owner?.phone ?? s.supportPhone ?? undefined,
      status: s.kycStatus,
      legalName: s.kycLegalName ?? undefined,
      licenseNo: s.kycLicenseNo ?? undefined,
      hasDocument: !!s.kycDocument,
      submittedAt: s.kycSubmittedAt?.toISOString(),
    };
  }
}
