import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import type { NoticeTone } from '../../database/schema/enums';
import {
  customers,
  notices,
  orders,
  products,
  shops,
  subscriptions,
} from '../../database/schema';
import type { ShopRow } from '../../database/schema';
import { NoticesService } from '../notices/notices.service';
import type {
  NoticeListResponse,
  NoticeResponse,
} from '../notices/dto/notice.dto';
import { PlatformCustomerListResponse } from './dto/platform-customer.response';
import { PlatformKycQueryDto } from './dto/platform-kyc-query.dto';
import {
  PlatformKycDetailResponse,
  PlatformKycListResponse,
  PlatformKycResponse,
} from './dto/platform-kyc.response';
import { UpdatePlatformShopDto } from './dto/platform-shop-action.dto';
import {
  PlatformShopDetailResponse,
  PlatformShopListResponse,
} from './dto/platform-shop.response';

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
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly notices: NoticesService,
  ) {}

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
          suspended: !!s.suspendedAt,
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

  /**
   * One shop in full, for the operator's detail drawer. The list row plus the
   * context an operator needs before switching a live business off: what it
   * has sold over its life, how big the catalog is, whether it is verified,
   * and how it pays the platform.
   */
  async getShop(shopId: string): Promise<PlatformShopDetailResponse> {
    const shop = await this.requireShop(shopId);
    const since = new Date(Date.now() - THIRTY_DAYS_MS);

    const [[lifetime], [recent], [placed], [buyers], [catalog], sub] =
      await Promise.all([
        // Paid trade over the shop's whole life, plus when it last sold.
        this.db
          .select({
            cents: sql<string>`coalesce(sum(${orders.totalCents}), 0)`,
            lastAt: sql<string | null>`max(${orders.placedAt})`,
          })
          .from(orders)
          .where(and(eq(orders.shopId, shopId), eq(orders.pay, 'Paid'))),
        this.db
          .select({
            cents: sql<string>`coalesce(sum(${orders.totalCents}), 0)`,
            n: count(),
          })
          .from(orders)
          .where(
            and(
              eq(orders.shopId, shopId),
              eq(orders.pay, 'Paid'),
              gte(orders.placedAt, since),
            ),
          ),
        // Every order ever placed, paid or not.
        this.db
          .select({ n: count() })
          .from(orders)
          .where(eq(orders.shopId, shopId)),
        this.db
          .select({ n: count() })
          .from(customers)
          .where(eq(customers.shopId, shopId)),
        this.db
          .select({ n: count() })
          .from(products)
          .where(eq(products.shopId, shopId)),
        this.db.query.subscriptions.findFirst({
          where: eq(subscriptions.shopId, shopId),
          columns: { billingMode: true, status: true, dueCents: true },
        }),
      ]);

    return {
      id: shop.id,
      name: shop.name,
      handle: shop.handle,
      ownerName: shop.owner?.name ?? '-',
      email: shop.owner?.email ?? undefined,
      phone: shop.owner?.phone ?? shop.supportPhone ?? undefined,
      currency: shop.currency,
      live: shop.live,
      suspended: !!shop.suspendedAt,
      sales30d: toMajor(Number(recent.cents)),
      orders30d: recent.n,
      createdAt: shop.createdAt.toISOString(),
      tagline: shop.tagline ?? undefined,
      cat: shop.cat,
      language: shop.language,
      plan: shop.plan,
      botChatEnabled: shop.botChatEnabled,
      kycStatus: shop.kycStatus,
      suspendedAt: shop.suspendedAt?.toISOString(),
      suspendedReason: shop.suspendedReason ?? undefined,
      supportEmail: shop.supportEmail ?? undefined,
      hasPayoutBank: !!shop.payoutBank,
      products: catalog.n,
      ordersTotal: placed.n,
      salesTotal: toMajor(Number(lifetime.cents)),
      customers: buyers.n,
      lastOrderAt: lifetime.lastAt
        ? new Date(lifetime.lastAt).toISOString()
        : undefined,
      billingMode: sub?.billingMode,
      billingStatus: sub?.status,
      dueAmount: sub ? toMajor(sub.dueCents) : undefined,
    };
  }

  /**
   * Flip the operator's two switches on a shop.
   *
   * Suspending forces the storefront off in the same write, which is what lets
   * every buyer-facing route keep checking only `live`. Lifting a suspension
   * puts the shop back on sale - the operator is returning it to service, and
   * if its billing is actually in arrears the hourly sweep pauses it again on
   * its own terms.
   *
   * `live` on its own is the softer action: the shop goes dark, but the seller
   * can re-open it themselves.
   */
  async updateShop(
    shopId: string,
    dto: UpdatePlatformShopDto,
  ): Promise<PlatformShopDetailResponse> {
    const shop = await this.requireShop(shopId);

    const patch: {
      live?: boolean;
      suspendedAt?: Date | null;
      suspendedReason?: string | null;
    } = {};

    if (dto.suspended !== undefined && dto.suspended !== !!shop.suspendedAt) {
      if (dto.suspended) {
        patch.suspendedAt = new Date();
        patch.suspendedReason = dto.reason?.trim() || null;
        patch.live = false;
      } else {
        patch.suspendedAt = null;
        patch.suspendedReason = null;
        patch.live = true;
      }
    }
    // An explicit `live` wins over the suspension's implied one, except that a
    // shop cannot be left on sale while it is (or is being) suspended.
    if (dto.live !== undefined) {
      const suspended = dto.suspended ?? !!shop.suspendedAt;
      patch.live = suspended ? false : dto.live;
    }

    if (Object.keys(patch).length) {
      await this.db.update(shops).set(patch).where(eq(shops.id, shopId));
    }

    // Tell the seller why their shop went off - a silent suspension leaves
    // them staring at a dead storefront with nothing to act on.
    if (patch.suspendedAt) {
      await this.notices.create(
        patch.suspendedReason
          ? `Your shop has been suspended by Hoomri: ${patch.suspendedReason}`
          : 'Your shop has been suspended by Hoomri. Contact support to resolve it.',
        'danger',
        shopId,
      );
    } else if (patch.suspendedAt === null) {
      // Retire the banner the suspension raised before announcing the lift,
      // or the seller reads "you are suspended" and "you are back" at once.
      // The window is exactly the suspension's: urgent notices to this shop
      // from the moment it went off until now.
      if (shop.suspendedAt) {
        await this.db
          .update(notices)
          .set({ active: false })
          .where(
            and(
              eq(notices.shopId, shopId),
              eq(notices.tone, 'danger'),
              eq(notices.active, true),
              gte(notices.createdAt, shop.suspendedAt),
            ),
          );
      }
      await this.notices.create(
        'Your shop’s suspension has been lifted - your storefront is live again.',
        'success',
        shopId,
      );
    }

    return this.getShop(shopId);
  }

  /**
   * The operator's message thread with one shop: notices addressed to this
   * shop alone, oldest first so it reads like a conversation. Broadcasts to
   * every shop are the Notices screen's business, not this drawer's.
   */
  async listShopMessages(shopId: string): Promise<NoticeListResponse> {
    await this.requireShop(shopId);
    const rows = await this.db.query.notices.findMany({
      where: eq(notices.shopId, shopId),
      orderBy: [asc(notices.createdAt)],
    });
    return {
      data: rows.map((n) => ({
        id: n.id,
        shopId: n.shopId ?? undefined,
        message: n.message,
        tone: n.tone,
        active: n.active,
        createdAt: n.createdAt.toISOString(),
      })),
    };
  }

  /** Send the seller a message. It banners at the top of their console. */
  async messageShop(
    shopId: string,
    message: string,
    tone: NoticeTone = 'info',
  ): Promise<NoticeResponse> {
    await this.requireShop(shopId);
    return this.notices.create(message, tone, shopId);
  }

  private async requireShop(shopId: string) {
    const shop = await this.db.query.shops.findFirst({
      where: eq(shops.id, shopId),
      with: { owner: { columns: { name: true, email: true, phone: true } } },
    });
    if (!shop) throw new NotFoundException('Shop not found');
    return shop;
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
