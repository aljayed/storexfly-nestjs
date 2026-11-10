import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq, inArray, ne } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import {
  orders,
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
        supplier.live &&
        product.listingType === 'sale' &&
        product.commerce.channels.includes('reseller') &&
        listing.sellingPriceCents >=
          (product.commerce.resellerPriceCents ?? Infinity) &&
        enabledCollection.some((method) =>
          supplier.paymentMethods.includes(method.kind),
        ),
      supplierName: supplier.name,
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
    const rows = await this.db.query.orders.findMany({
      where: eq(orders.resellerShopId, shopId),
      orderBy: desc(orders.placedAt),
      limit: 200,
    });
    return rows.map((o) => ({
      id: o.id,
      reference: o.reference,
      customer: o.customerName,
      status: o.status,
      pay: o.pay,
      total: o.totalCents / 100,
      margin: o.resellerMarginCents / 100,
      placedAt: o.placedAt,
      courierTrackingCode: o.courierTrackingCode,
    }));
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
