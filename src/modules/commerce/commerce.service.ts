import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, count, desc, eq, gte, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import {
  orders,
  orderItems,
  reviews,
  paymentMethods,
  products,
  resellerListings,
  shops,
  subscriptions,
  tradeDisputes,
  users,
  tradeMessages,
  tradeQuotes,
} from '../../database/schema';
import { dollarsToCents } from '../../common/utils/money.util';
import {
  commerceUnitPrice,
  resellerVariantCombinations,
} from '../../common/commerce/commerce';
import { ProductResponse } from '../products/dto/product.response';
import { ProductDetailResponse } from '../products/dto/product-detail.response';
import { ShopResponse } from '../shops/dto/shop.response';
import type {
  OpenDisputeDto,
  RequestQuoteDto,
  RespondQuoteDto,
  ResellerListingDto,
  UpdateResellerListingDto,
} from './commerce.dto';

@Injectable()
export class CommerceService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}
  private async source(productId: string) {
    const product = await this.db.query.products.findFirst({
      where: eq(products.id, productId),
    });
    const shop =
      product &&
      (await this.db.query.shops.findFirst({
        where: eq(shops.id, product.shopId),
      }));
    if (!product || !shop?.live || product.listingType !== 'sale')
      throw new NotFoundException('This supplier product is unavailable.');
    return { product, shop };
  }
  async sourceOffer(shopId: string, productId: string) {
    const { product, shop } = await this.source(productId);
    const target = await this.db.query.shops.findFirst({
      where: eq(shops.id, shopId),
    });
    if (target?.id === shop.id || target?.ownerId === shop.ownerId)
      throw new ConflictException('Choose a product from another supplier.');
    if (!target || target.currency !== shop.currency)
      throw new ConflictException(
        'Choose a supplier using your store currency.',
      );
    if (
      !product.commerce.channels.includes('reseller') ||
      product.commerce.resellerPriceCents == null
    )
      throw new ConflictException(
        'This product is not available for reselling.',
      );
    return {
      name: product.name,
      resellerPrice: product.commerce.resellerPriceCents / 100,
      suggestedPrice: product.priceCents / 100,
      stock: product.stock,
      supplierName: shop.name,
      supplierVerified: shop.kycStatus === 'verified',
    };
  }
  async importListing(shopId: string, dto: ResellerListingDto) {
    const { product, shop } = await this.source(dto.productId);
    const target = await this.db.query.shops.findFirst({
      where: eq(shops.id, shopId),
    });
    if (!target || target.id === shop.id || target.ownerId === shop.ownerId)
      throw new BadRequestException('Choose a product from another supplier.');
    if (target.currency !== shop.currency)
      throw new BadRequestException(
        'Your store and supplier must use the same currency.',
      );
    const sub = await this.db.query.subscriptions.findFirst({
      where: eq(subscriptions.shopId, shopId),
    });
    if (sub?.status === 'cancelled')
      throw new ForbiddenException(
        'Resume your subscription to import products.',
      );
    if (
      !product.commerce.channels.includes('reseller') ||
      product.commerce.resellerPriceCents == null
    )
      throw new ConflictException('This supplier has not enabled reselling.');
    const collectionMethods = await this.db.query.paymentMethods.findMany({
      where: and(
        eq(paymentMethods.enabled, true),
        ne(paymentMethods.gateway, 'none'),
      ),
    });
    if (
      !collectionMethods.some((method) =>
        shop.paymentMethods.includes(method.kind),
      )
    )
      throw new ConflictException(
        'The supplier must enable an online payment method before this product can be resold.',
      );
    const sellingPriceCents = dollarsToCents(dto.sellingPrice);
    if (sellingPriceCents < product.commerce.resellerPriceCents)
      throw new BadRequestException(
        'Your selling price must cover the supplier price.',
      );
    const [row] = await this.db
      .insert(resellerListings)
      .values({ shopId, productId: product.id, sellingPriceCents })
      .onConflictDoUpdate({
        target: [resellerListings.shopId, resellerListings.productId],
        set: { sellingPriceCents, active: true },
      })
      .returning();
    return {
      ...row,
      sellingPrice: row.sellingPriceCents / 100,
      sharePath: `/shop/${target.handle}/p/resell-${row.id}`,
    };
  }
  async listings(shopId: string) {
    const target = await this.db.query.shops.findFirst({
      where: eq(shops.id, shopId),
    });
    const rows = await this.db
      .select({ listing: resellerListings, product: products, supplier: shops })
      .from(resellerListings)
      .innerJoin(products, eq(products.id, resellerListings.productId))
      .innerJoin(shops, eq(shops.id, products.shopId))
      .where(eq(resellerListings.shopId, shopId))
      .orderBy(desc(resellerListings.createdAt));
    const enabledCollection = await this.db.query.paymentMethods.findMany({
      where: and(
        eq(paymentMethods.enabled, true),
        ne(paymentMethods.gateway, 'none'),
      ),
    });
    return rows.map(({ listing, product, supplier }) => ({
      id: listing.id,
      productId: product.id,
      name: product.name,
      image: product.images?.[0],
      stock: product.stock,
      active: listing.active,
      available:
        product.stock > 0 &&
        supplier.live &&
        product.listingType === 'sale' &&
        product.commerce.channels.includes('reseller') &&
        listing.sellingPriceCents >=
          (product.commerce.resellerPriceCents ?? Infinity) &&
        enabledCollection.some((method) =>
          supplier.paymentMethods.includes(method.kind),
        ),
      supplierName: supplier.name,
      supplierHandle: supplier.handle,
      supplierVerified: supplier.kycStatus === 'verified',
      sellingPrice: listing.sellingPriceCents / 100,
      supplyPrice: (product.commerce.resellerPriceCents ?? 0) / 100,
      margin:
        (listing.sellingPriceCents -
          (product.commerce.resellerPriceCents ?? 0)) /
        100,
      sharePath: `/shop/${target?.handle}/p/resell-${listing.id}`,
    }));
  }
  async updateListing(
    shopId: string,
    id: string,
    dto: UpdateResellerListingDto,
  ) {
    const listing = await this.db.query.resellerListings.findFirst({
      where: and(
        eq(resellerListings.id, id),
        eq(resellerListings.shopId, shopId),
      ),
    });
    if (!listing) throw new NotFoundException('Listing not found');
    if (dto.sellingPrice !== undefined)
      await this.importListing(shopId, {
        productId: listing.productId,
        sellingPrice: dto.sellingPrice,
      });
    await this.db
      .update(resellerListings)
      .set({ active: dto.active ?? listing.active })
      .where(eq(resellerListings.id, id));
    return { ok: true };
  }
  /**
   * Apply one pricing rule across many listings. Each price goes through the
   * same checks as a single edit (supplier still open to resellers, price
   * covers supply), and one refusal never blocks the rest - the reseller is
   * told which listings kept their old price and why.
   */
  async repriceListings(
    shopId: string,
    items: { id: string; sellingPrice: number }[],
  ) {
    const seen = new Set<string>();
    const results: { id: string; ok: boolean; error?: string }[] = [];
    for (const item of items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      try {
        await this.updateListing(shopId, item.id, {
          sellingPrice: item.sellingPrice,
        });
        results.push({ id: item.id, ok: true });
      } catch (e) {
        results.push({
          id: item.id,
          ok: false,
          error: e instanceof Error ? e.message : 'Could not update',
        });
      }
    }
    return {
      updated: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok),
    };
  }
  async publicListing(id: string) {
    const listing = await this.db.query.resellerListings.findFirst({
      where: eq(resellerListings.id, id),
    });
    if (!listing?.active) throw new NotFoundException('Listing not found');
    const { product, shop: supplier } = await this.source(listing.productId);
    const shop = await this.db.query.shops.findFirst({
      where: eq(shops.id, listing.shopId),
    });
    if (
      !shop?.live ||
      !product.commerce.channels.includes('reseller') ||
      listing.sellingPriceCents <
        (product.commerce.resellerPriceCents ?? Infinity)
    )
      throw new NotFoundException('Listing is temporarily unavailable');
    const collectionMethods = await this.db.query.paymentMethods.findMany({
      where: and(
        eq(paymentMethods.enabled, true),
        ne(paymentMethods.gateway, 'none'),
      ),
    });
    if (
      !collectionMethods.some((method) =>
        supplier.paymentMethods.includes(method.kind),
      )
    )
      throw new NotFoundException(
        'This reseller offer is temporarily unavailable.',
      );
    const sourceReviews = await this.db.query.reviews.findMany({
      where: eq(reviews.productId, product.id),
      orderBy: desc(reviews.createdAt),
    });
    const publicProduct = ProductDetailResponse.fromRows(
      {
        ...product,
        id,
        shopId: shop.id,
        priceCents: listing.sellingPriceCents,
        comparePriceCents: null,
        packs: [],
        commerce: { channels: ['retail'] },
        variantCombinations: resellerVariantCombinations(
          product,
          listing.sellingPriceCents,
        ),
      },
      sourceReviews,
    );
    return {
      product: {
        ...publicProduct,
        slug: `resell-${id}`,
        combos: [],
      },
      shop: {
        ...ShopResponse.fromRow(shop),
        deliveryCity: supplier.deliveryCity,
        deliveryCoverage: supplier.deliveryCoverage,
        deliveryInsideDays: supplier.deliveryInsideDays,
        deliveryOutsideDays: supplier.deliveryOutsideDays,
        deliveryInsideFee: supplier.deliveryInsideCents / 100,
        deliveryOutsideFee: supplier.deliveryOutsideCents / 100,
        codAdvanceEnabled: false,
        paymentMethods: supplier.paymentMethods.filter((m) => m !== 'cod'),
      },
    };
  }
  async publicStore(handle: string) {
    const shop = await this.db.query.shops.findFirst({
      where: and(eq(shops.handle, handle), eq(shops.live, true)),
    });
    if (!shop) throw new NotFoundException('Shop not found');
    const [rows, methods] = await Promise.all([
      this.db
        .select({
          listing: resellerListings,
          product: products,
          supplier: shops,
        })
        .from(resellerListings)
        .innerJoin(products, eq(products.id, resellerListings.productId))
        .innerJoin(shops, eq(shops.id, products.shopId))
        .where(
          and(
            eq(resellerListings.shopId, shop.id),
            eq(resellerListings.active, true),
          ),
        )
        .limit(200),
      this.db.query.paymentMethods.findMany({
        where: and(
          eq(paymentMethods.enabled, true),
          ne(paymentMethods.gateway, 'none'),
        ),
      }),
    ]);
    return {
      products: rows
        .filter(
          ({ listing, product, supplier }) =>
            supplier.live &&
            product.listingType === 'sale' &&
            product.commerce.channels.includes('reseller') &&
            listing.sellingPriceCents >=
              (product.commerce.resellerPriceCents ?? Infinity) &&
            methods.some((method) =>
              supplier.paymentMethods.includes(method.kind),
            ),
        )
        .map(({ listing, product }) =>
          ProductResponse.fromRow({
            ...product,
            id: listing.id,
            shopId: shop.id,
            slug: `resell-${listing.id}`,
            priceCents: listing.sellingPriceCents,
            comparePriceCents: null,
            packs: [],
            commerce: { channels: ['retail'] },
            variantCombinations: resellerVariantCombinations(
              product,
              listing.sellingPriceCents,
            ),
          }),
        ),
    };
  }
  async resellerOrders(shopId: string) {
    const rows = await this.db
      .select({ order: orders, supplierName: shops.name, supplierHandle: shops.handle })
      .from(orders)
      .innerJoin(shops, eq(shops.id, orders.shopId))
      .where(and(eq(orders.resellerShopId, shopId), ne(orders.pay, 'Pending')))
      .orderBy(desc(orders.placedAt))
      .limit(200);
    const items = rows.length
      ? await this.db
          .select({ orderId: orderItems.orderId, name: orderItems.name, qty: orderItems.qty, variant: orderItems.variant })
          .from(orderItems)
          .where(and(inArray(orderItems.orderId, rows.map((r) => r.order.id)), isNotNull(orderItems.productId)))
      : [];
    return rows.map(({ order: o, supplierName, supplierHandle }) => ({
      id: o.id,
      reference: o.reference,
      customer: o.customerName,
      phone: o.phone,
      area: o.address?.area ?? null,
      status: o.status,
      pay: o.pay,
      total: o.totalCents / 100,
      margin: o.resellerMarginCents / 100,
      placedAt: o.placedAt,
      courierTrackingCode: o.courierTrackingCode,
      supplierName,
      supplierHandle,
      items: items
        .filter((i) => i.orderId === o.id)
        .map(({ name, qty, variant }) => ({ name, qty, variant })),
    }));
  }

  /**
   * One read for the console dashboards. Both sides of the network are
   * answered for the same shop - what it supplies (wholesale buyers and the
   * resellers carrying its products) and what it resells - so a shop that
   * switches business type sees its numbers straight away.
   */
  async summary(shopId: string) {
    const DAY = 86_400_000;
    const now = Date.now();
    const since30 = new Date(now - 30 * DAY);
    const since14 = new Date(now - 13 * DAY);
    since14.setUTCHours(0, 0, 0, 0);
    const paid = sql`${orders.pay} = 'Paid' and ${orders.status} <> 'Cancelled'`;

    const [
      catalog,
      partnerRows,
      supplierModes,
      supplierDaily,
      quoteRows,
      myListings,
      resold,
      resoldDaily,
      topResold,
      openCases,
    ] = await Promise.all([
      this.db
        .select({
          id: products.id,
          name: products.name,
          image: sql<string | null>`${products.images}[1]`,
          stock: products.stock,
          priceCents: products.priceCents,
          commerce: products.commerce,
        })
        .from(products)
        .where(and(eq(products.shopId, shopId), eq(products.listingType, 'sale'))),
      // Shops reselling this shop's products.
      this.db
        .select({
          shopId: resellerListings.shopId,
          name: shops.name,
          handle: shops.handle,
          verified: shops.kycStatus,
          listings: count(),
          active: sql<number>`count(*) filter (where ${resellerListings.active})`.mapWith(Number),
          since: sql<Date>`min(${resellerListings.createdAt})`,
        })
        .from(resellerListings)
        .innerJoin(products, eq(products.id, resellerListings.productId))
        .innerJoin(shops, eq(shops.id, resellerListings.shopId))
        .where(eq(products.shopId, shopId))
        .groupBy(resellerListings.shopId, shops.name, shops.handle, shops.kycStatus),
      // Trade this shop fulfilled as the supplier, last 30 days.
      this.db
        .select({
          mode: orders.commerceMode,
          orders: count(),
          // Qualified by hand: inside the subquery a bare "id" would bind to order_items.
          units: sql<number>`coalesce(sum((select sum(oi.qty) from order_items oi where oi.order_id = "orders"."id" and oi.product_id is not null)), 0)`.mapWith(Number),
          revenueCents: sql<number>`coalesce(sum(${orders.totalCents} - ${orders.resellerMarginCents}) filter (where ${paid}), 0)`.mapWith(Number),
          open: sql<number>`count(*) filter (where ${orders.status} in ('New','Confirmed','Packed'))`.mapWith(Number),
        })
        .from(orders)
        .where(and(eq(orders.shopId, shopId), ne(orders.commerceMode, 'retail'), ne(orders.pay, 'Pending'), gte(orders.placedAt, since30)))
        .groupBy(orders.commerceMode),
      this.db
        .select({
          day: sql<string>`to_char(date_trunc('day', ${orders.placedAt} at time zone 'UTC'), 'YYYY-MM-DD')`,
          cents: sql<number>`coalesce(sum(${orders.totalCents} - ${orders.resellerMarginCents}) filter (where ${paid}), 0)`.mapWith(Number),
          orders: count(),
        })
        .from(orders)
        .where(and(eq(orders.shopId, shopId), ne(orders.commerceMode, 'retail'), ne(orders.pay, 'Pending'), gte(orders.placedAt, since14)))
        .groupBy(sql`1`),
      this.db
        .select({ status: tradeQuotes.status, n: count(), expired: sql<number>`count(*) filter (where ${tradeQuotes.expiresAt} <= now() and ${tradeQuotes.usedAt} is null)`.mapWith(Number), used: sql<number>`count(*) filter (where ${tradeQuotes.usedAt} is not null)`.mapWith(Number), valueCents: sql<number>`coalesce(sum(${tradeQuotes.unitPriceCents} * ${tradeQuotes.qty}) filter (where ${tradeQuotes.usedAt} is null and (${tradeQuotes.expiresAt} is null or ${tradeQuotes.expiresAt} > now())), 0)`.mapWith(Number) })
        .from(tradeQuotes)
        .where(eq(tradeQuotes.shopId, shopId))
        .groupBy(tradeQuotes.status),
      // What this shop resells.
      this.db
        .select({ total: count(), active: sql<number>`count(*) filter (where ${resellerListings.active})`.mapWith(Number), suppliers: sql<number>`count(distinct ${products.shopId})`.mapWith(Number) })
        .from(resellerListings)
        .innerJoin(products, eq(products.id, resellerListings.productId))
        .where(eq(resellerListings.shopId, shopId)),
      this.db
        .select({
          orders: count(),
          marginCents: sql<number>`coalesce(sum(${orders.resellerMarginCents}) filter (where ${paid}), 0)`.mapWith(Number),
          earnedCents: sql<number>`coalesce(sum(${orders.resellerMarginCents}) filter (where ${paid} and ${orders.status} = 'Delivered'), 0)`.mapWith(Number),
          salesCents: sql<number>`coalesce(sum(${orders.totalCents}) filter (where ${paid}), 0)`.mapWith(Number),
          inTransit: sql<number>`count(*) filter (where ${orders.status} in ('New','Confirmed','Packed','HandedOver','Shipped'))`.mapWith(Number),
        })
        .from(orders)
        .where(and(eq(orders.resellerShopId, shopId), ne(orders.pay, 'Pending'), gte(orders.placedAt, since30))),
      this.db
        .select({
          day: sql<string>`to_char(date_trunc('day', ${orders.placedAt} at time zone 'UTC'), 'YYYY-MM-DD')`,
          cents: sql<number>`coalesce(sum(${orders.resellerMarginCents}) filter (where ${paid}), 0)`.mapWith(Number),
          orders: count(),
        })
        .from(orders)
        .where(and(eq(orders.resellerShopId, shopId), ne(orders.pay, 'Pending'), gte(orders.placedAt, since14)))
        .groupBy(sql`1`),
      this.db
        .select({
          listingId: orders.resellerListingId,
          orders: count(),
          marginCents: sql<number>`coalesce(sum(${orders.resellerMarginCents}) filter (where ${paid}), 0)`.mapWith(Number),
        })
        .from(orders)
        .where(and(eq(orders.resellerShopId, shopId), ne(orders.pay, 'Pending'), gte(orders.placedAt, since30)))
        .groupBy(orders.resellerListingId)
        .orderBy(desc(count()))
        .limit(5),
      this.db
        .select({ n: count() })
        .from(tradeDisputes)
        .where(and(eq(tradeDisputes.shopId, shopId), ne(tradeDisputes.status, 'resolved'))),
    ]);

    const days = Array.from({ length: 14 }, (_, i) => new Date(since14.getTime() + i * DAY).toISOString().slice(0, 10));
    const series = (rows: { day: string; cents: number; orders: number }[]) =>
      days.map((day) => {
        const hit = rows.find((r) => r.day === day);
        return { day, value: (hit?.cents ?? 0) / 100, orders: hit?.orders ?? 0 };
      });
    const mode = (m: string) => supplierModes.find((r) => r.mode === m);
    const quotes = Object.fromEntries(quoteRows.map((r) => [r.status, r]));
    const carried = new Map<string, number>();
    if (catalog.length) {
      const rows = await this.db
        .select({ productId: resellerListings.productId, n: count() })
        .from(resellerListings)
        .where(and(inArray(resellerListings.productId, catalog.map((p) => p.id)), eq(resellerListings.active, true)))
        .groupBy(resellerListings.productId);
      for (const r of rows) carried.set(r.productId, r.n);
    }
    const topIds = topResold.map((t) => t.listingId).filter((id): id is string => !!id);
    const topNames = topIds.length
      ? await this.db
          .select({ id: resellerListings.id, name: products.name, image: sql<string | null>`${products.images}[1]` })
          .from(resellerListings)
          .innerJoin(products, eq(products.id, resellerListings.productId))
          .where(inArray(resellerListings.id, topIds))
      : [];
    const r = resold[0];
    const l = myListings[0];
    return {
      supplier: {
        wholesaleProducts: catalog.filter((p) => p.commerce.channels.includes('wholesale')).length,
        resellableProducts: catalog.filter((p) => p.commerce.channels.includes('reseller')).length,
        catalogProducts: catalog.length,
        tradeReadyProducts: catalog.filter((p) => p.commerce.channels.some((c) => c !== 'retail')).length,
        lowStock: catalog
          .filter((p) => p.commerce.channels.some((c) => c !== 'retail') && p.stock < Math.max(10, p.commerce.wholesaleMoq ?? 1))
          .map((p) => ({ id: p.id, name: p.name, image: p.image, stock: p.stock, moq: p.commerce.wholesaleMoq ?? 1 }))
          .slice(0, 6),
        partners: partnerRows
          .map((p) => ({ ...p, verified: p.verified === 'verified' }))
          .sort((a, b) => b.active - a.active),
        carriedBy: Object.fromEntries(carried),
        wholesale30d: { orders: mode('wholesale')?.orders ?? 0, units: mode('wholesale')?.units ?? 0, revenue: (mode('wholesale')?.revenueCents ?? 0) / 100, open: mode('wholesale')?.open ?? 0 },
        dropship30d: { orders: mode('reseller')?.orders ?? 0, units: mode('reseller')?.units ?? 0, revenue: (mode('reseller')?.revenueCents ?? 0) / 100, open: mode('reseller')?.open ?? 0 },
        quotes: {
          requested: quotes.requested?.n ?? 0,
          quoted: (quotes.quoted?.n ?? 0) - (quotes.quoted?.expired ?? 0),
          accepted: (quotes.accepted?.n ?? 0) - (quotes.accepted?.used ?? 0) - (quotes.accepted?.expired ?? 0),
          won: quotes.accepted?.used ?? 0,
          lost: (quotes.declined?.n ?? 0) + (quotes.cancelled?.n ?? 0) + (quotes.quoted?.expired ?? 0) + (quotes.accepted?.expired ?? 0),
          pipelineValue: ((quotes.quoted?.valueCents ?? 0) + (quotes.accepted?.valueCents ?? 0)) / 100,
        },
        openCases: openCases[0]?.n ?? 0,
        series: series(supplierDaily),
      },
      reseller: {
        listings: l?.total ?? 0,
        activeListings: l?.active ?? 0,
        suppliers: l?.suppliers ?? 0,
        orders30d: r?.orders ?? 0,
        sales30d: (r?.salesCents ?? 0) / 100,
        margin30d: (r?.marginCents ?? 0) / 100,
        earned30d: (r?.earnedCents ?? 0) / 100,
        inTransit: r?.inTransit ?? 0,
        top: topResold.map((t) => {
          const named = topNames.find((n) => n.id === t.listingId);
          return { listingId: t.listingId, name: named?.name ?? '-', image: named?.image ?? null, orders: t.orders, margin: t.marginCents / 100 };
        }),
        series: series(resoldDaily),
      },
    };
  }

  async buyerOrders(buyerId: string) {
    const rows = await this.db
      .select({ order: orders, currency: shops.currency })
      .from(orders)
      .innerJoin(shops, eq(shops.id, orders.shopId))
      .where(and(eq(orders.userId, buyerId), ne(orders.commerceMode, 'retail')))
      .orderBy(desc(orders.placedAt))
      .limit(200);
    return rows.map(({ order: o, currency }) => ({
      id: o.id,
      reference: o.reference,
      customer: o.customerName,
      status: o.status,
      pay: o.pay,
      total: o.totalCents / 100,
      margin: 0,
      currency,
      placedAt: o.placedAt,
      courierTrackingCode: o.courierTrackingCode,
    }));
  }
  async requestQuote(buyerId: string, dto: RequestQuoteDto) {
    const { product, shop } = await this.source(dto.productId);
    if (!product.commerce.channels.includes('wholesale'))
      throw new ConflictException(
        'This product is not available for wholesale.',
      );
    if (shop.ownerId === buyerId)
      throw new ForbiddenException(
        'You cannot request a quote from your own shop.',
      );
    if (dto.kind === 'sample' && dto.qty !== 1)
      throw new BadRequestException('A sample request is for one unit.');
    const variant = dto.variant ?? {};
    if (
      Object.keys(variant).length !== product.variantGroups.length ||
      product.variantGroups.some(
        (g) => !g.options.some((o) => o.id === variant[g.id]),
      )
    )
      throw new BadRequestException('Choose one option for every variant.');
    if (
      product.variantCombinations.length &&
      !product.variantCombinations.some(
        (v) =>
          v.available &&
          Object.entries(variant).every(([g, o]) => v.optionIds[g] === o),
      )
    )
      throw new ConflictException('This variant combination is unavailable.');
    const [quote] = await this.db
      .insert(tradeQuotes)
      .values({
        buyerId,
        shopId: shop.id,
        productId: product.id,
        kind: dto.kind ?? 'bulk',
        qty: dto.qty,
        variant,
        message: dto.message.trim(),
      })
      .returning();
    return quote;
  }
  async quotes(identity: { buyerId: string } | { shopId: string }) {
    const where =
      'buyerId' in identity
        ? eq(tradeQuotes.buyerId, identity.buyerId)
        : eq(tradeQuotes.shopId, identity.shopId);
    const rows = await this.db
      .select({
        quote: tradeQuotes,
        productName: products.name,
        productSlug: products.slug,
        productImages: products.images,
        retailCents: products.priceCents,
        commerce: products.commerce,
        variantGroups: products.variantGroups,
        supplierName: shops.name,
        supplierHandle: shops.handle,
        supplierVerified: shops.kycStatus,
        currency: shops.currency,
        buyerName: users.name,
      })
      .from(tradeQuotes)
      .innerJoin(products, eq(products.id, tradeQuotes.productId))
      .innerJoin(shops, eq(shops.id, tradeQuotes.shopId))
      .innerJoin(users, eq(users.id, tradeQuotes.buyerId))
      .where(where)
      .orderBy(desc(tradeQuotes.updatedAt))
      .limit(200);
    // One query for every thread instead of one per quote.
    const messages = rows.length
      ? await this.db
          .select()
          .from(tradeMessages)
          .where(
            inArray(
              tradeMessages.quoteId,
              rows.map((r) => r.quote.id),
            ),
          )
          .orderBy(asc(tradeMessages.createdAt))
      : [];
    const byQuote = new Map<string, (typeof messages)[number][]>();
    for (const m of messages) {
      const list = byQuote.get(m.quoteId) ?? [];
      list.push(m);
      byQuote.set(m.quoteId, list);
    }
    const now = Date.now();
    return rows.map(
      ({
        quote,
        productImages,
        retailCents,
        commerce,
        variantGroups,
        buyerName,
        ...context
      }) => {
        // The tier price the supplier would charge without negotiating: a
        // starting point for their offer and a yardstick for the buyer.
        let tierCents: number | null = null;
        try {
          tierCents = commerceUnitPrice(
            commerce,
            'wholesale',
            quote.qty,
            retailCents,
          );
        } catch {
          tierCents = null;
        }
        const variantLabel =
          (variantGroups ?? [])
            .map((g) => {
              const option = g.options.find(
                (o) => o.id === quote.variant[g.id],
              );
              return option ? `${g.name}: ${option.label}` : null;
            })
            .filter(Boolean)
            .join(' · ') || null;
        return {
          ...quote,
          ...context,
          // Suppliers see who is asking; buyers already know who they are.
          buyerName: 'shopId' in identity ? buyerName : undefined,
          productImage: productImages?.[0] ?? null,
          variantLabel,
          retailPrice: retailCents / 100,
          tierPrice: tierCents == null ? null : tierCents / 100,
          expired:
            ['quoted', 'accepted'].includes(quote.status) &&
            !quote.usedAt &&
            (!quote.expiresAt || quote.expiresAt.getTime() <= now),
          unitPrice:
            quote.unitPriceCents == null ? null : quote.unitPriceCents / 100,
          messages: byQuote.get(quote.id) ?? [],
        };
      },
    );
  }
  async respondQuote(shopId: string, id: string, dto: RespondQuoteDto) {
    return this.db.transaction(async (tx) => {
      const [quote] = await tx
        .select()
        .from(tradeQuotes)
        .where(and(eq(tradeQuotes.id, id), eq(tradeQuotes.shopId, shopId)))
        .for('update');
      if (!quote) throw new NotFoundException('Quote not found');
      if (!['requested', 'quoted'].includes(quote.status) || quote.usedAt)
        throw new ConflictException('This quote can no longer be changed.');
      if (dto.action === 'quote' && dto.unitPrice == null)
        throw new BadRequestException('Enter a unit price.');
      await tx
        .update(tradeQuotes)
        .set({
          status: dto.action === 'quote' ? 'quoted' : 'declined',
          unitPriceCents:
            dto.unitPrice == null ? null : dollarsToCents(dto.unitPrice),
          expiresAt:
            dto.action === 'quote'
              ? new Date(Date.now() + (dto.validDays ?? 7) * 86_400_000)
              : null,
        })
        .where(eq(tradeQuotes.id, id));
      await tx
        .insert(tradeMessages)
        .values({ quoteId: id, sender: 'supplier', text: dto.message.trim() });
      return { ok: true };
    });
  }
  async decideQuote(buyerId: string, id: string, action: 'accept' | 'cancel') {
    return this.db.transaction(async (tx) => {
      const [quote] = await tx
        .select()
        .from(tradeQuotes)
        .where(and(eq(tradeQuotes.id, id), eq(tradeQuotes.buyerId, buyerId)))
        .for('update');
      if (!quote) throw new NotFoundException('Quote not found');
      if (quote.usedAt || ['cancelled', 'declined'].includes(quote.status))
        throw new ConflictException('This quote is closed.');
      if (
        action === 'accept' &&
        (quote.status !== 'quoted' ||
          !quote.expiresAt ||
          quote.expiresAt <= new Date())
      )
        throw new ConflictException('This quote has expired or is not ready.');
      await tx
        .update(tradeQuotes)
        .set({ status: action === 'accept' ? 'accepted' : 'cancelled' })
        .where(eq(tradeQuotes.id, id));
      return { ok: true };
    });
  }
  async messageQuote(
    identity: { buyerId: string } | { shopId: string },
    id: string,
    text: string,
  ) {
    const quote = await this.db.query.tradeQuotes.findFirst({
      where: and(
        eq(tradeQuotes.id, id),
        'buyerId' in identity
          ? eq(tradeQuotes.buyerId, identity.buyerId)
          : eq(tradeQuotes.shopId, identity.shopId),
      ),
    });
    if (!quote) throw new NotFoundException('Quote not found');
    if (quote.usedAt || ['declined', 'cancelled'].includes(quote.status))
      throw new ConflictException('This quote is closed.');
    await this.db.transaction(async (tx) => {
      await tx.insert(tradeMessages).values({
        quoteId: id,
        sender: 'buyerId' in identity ? 'buyer' : 'supplier',
        text: text.trim(),
      });
      // Keeps the busiest threads at the top of both inboxes.
      await tx
        .update(tradeQuotes)
        .set({ updatedAt: new Date() })
        .where(eq(tradeQuotes.id, id));
    });
    return { ok: true };
  }
  async openDispute(buyerId: string, dto: OpenDisputeDto) {
    const order = await this.db.query.orders.findFirst({
      where: and(eq(orders.id, dto.orderId), eq(orders.userId, buyerId)),
    });
    if (!order || order.commerceMode === 'retail')
      throw new NotFoundException('Trade order not found');
    if (
      order.pay !== 'Paid' ||
      !['Delivered', 'HandedOver'].includes(order.status)
    )
      throw new ConflictException(
        'A dispute is available after a paid order arrives.',
      );
    const [row] = await this.db
      .insert(tradeDisputes)
      .values({
        orderId: order.id,
        buyerId,
        shopId: order.shopId,
        reason: dto.reason.trim(),
      })
      .onConflictDoNothing()
      .returning();
    if (!row)
      throw new ConflictException('A dispute already exists for this order.');
    return row;
  }
  async disputes(identity: { buyerId: string } | { shopId: string }) {
    return this.db
      .select({
        dispute: tradeDisputes,
        reference: orders.reference,
        totalCents: orders.totalCents,
        currency: shops.currency,
      })
      .from(tradeDisputes)
      .innerJoin(orders, eq(orders.id, tradeDisputes.orderId))
      .innerJoin(shops, eq(shops.id, tradeDisputes.shopId))
      .where(
        'buyerId' in identity
          ? eq(tradeDisputes.buyerId, identity.buyerId)
          : eq(tradeDisputes.shopId, identity.shopId),
      )
      .orderBy(desc(tradeDisputes.createdAt))
      .limit(200);
  }
  async decideDispute(
    buyerId: string,
    id: string,
    action: 'accept' | 'escalate',
  ) {
    const [row] = await this.db
      .update(tradeDisputes)
      .set({
        status: action === 'accept' ? 'resolved' : 'escalated',
        resolvedAt: action === 'accept' ? new Date() : null,
      })
      .where(
        and(
          eq(tradeDisputes.id, id),
          eq(tradeDisputes.buyerId, buyerId),
          eq(tradeDisputes.status, 'proposed'),
        ),
      )
      .returning();
    if (!row)
      throw new ConflictException('There is no proposed resolution to review.');
    return row;
  }
  async platformDisputes() {
    return this.db
      .select({
        dispute: tradeDisputes,
        reference: orders.reference,
        totalCents: orders.totalCents,
        supplierName: shops.name,
      })
      .from(tradeDisputes)
      .innerJoin(orders, eq(orders.id, tradeDisputes.orderId))
      .innerJoin(shops, eq(shops.id, tradeDisputes.shopId))
      .where(ne(tradeDisputes.status, 'resolved'))
      .orderBy(desc(tradeDisputes.createdAt))
      .limit(200);
  }
  async platformResolve(id: string, resolution: string) {
    const [row] = await this.db
      .update(tradeDisputes)
      .set({
        status: 'resolved',
        resolution: resolution.trim(),
        resolvedAt: new Date(),
      })
      .where(
        and(eq(tradeDisputes.id, id), ne(tradeDisputes.status, 'resolved')),
      )
      .returning();
    if (!row) throw new NotFoundException('Open case not found');
    return row;
  }
  async resolveDispute(shopId: string, id: string, resolution: string) {
    const [row] = await this.db
      .update(tradeDisputes)
      .set({ status: 'proposed', resolution: resolution.trim() })
      .where(
        and(
          eq(tradeDisputes.id, id),
          eq(tradeDisputes.shopId, shopId),
          eq(tradeDisputes.status, 'open'),
        ),
      )
      .returning();
    if (!row) throw new NotFoundException('Open dispute not found');
    return row;
  }
}
