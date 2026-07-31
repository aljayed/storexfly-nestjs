import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, ilike, inArray, sql } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import {
  users,
  chatConversations,
  customers,
  orders,
  products,
  shops,
  type ChatConversationRow,
} from '../../database/schema';
import { centsToDollars } from '../../common/utils/money.util';
import { productLines } from '../../common/utils/order-line.util';
import type { ChatActor, CustomerActor, SellerActor } from './chat-actor';
import { ChatRealtimeService } from './chat-realtime.service';
import type { StartConversationDto } from './dto/chat.dto';

/** Caller-scoped conversation payload (unread counts are per-side). */
export interface ConversationDto {
  id: string;
  shop: {
    id: string;
    name: string;
    handle: string;
    brand: string;
    brandSoft: string;
    currency: string;
  };
  customer: { id: string; name: string };
  origin?: {
    type: 'product' | 'order';
    refId: string;
    title: string;
    subtitle: string;
    emoji: string;
    tone: string;
    /** Host-app link for the "open" chevron on the context strip. */
    url: string;
  };
  lastMessage?: {
    type: string;
    text: string;
    senderRole: 'customer' | 'seller';
    sentAt: string;
  };
  unreadCount: number;
  counterpartOnline: boolean;
  counterpartLastSeenAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** Seller context panel payload (maps to `CustomerContext` in the handoff). */
export interface CustomerContextDto {
  customerId: string;
  name: string;
  city?: string;
  segment: 'New' | 'Repeat' | 'VIP';
  ordersCount: number;
  totalSpent: number;
  currency: string;
  customerSince?: string;
  recentOrders: {
    orderId: string;
    displayId: string;
    itemsSummary: string;
    total: number;
    currency: string;
    status: string;
    placedAt: string;
  }[];
}

type ConversationWithParties = ChatConversationRow & {
  shop: typeof shops.$inferSelect;
  buyer: typeof users.$inferSelect;
};

@Injectable()
export class ConversationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly realtime: ChatRealtimeService,
  ) {}

  /** List the caller's conversations, newest activity first. */
  async list(
    actor: ChatActor,
    opts: {
      filter?: 'all' | 'unread';
      q?: string;
      cursor?: number;
      limit?: number;
    },
  ): Promise<{ items: ConversationDto[]; nextCursor?: number }> {
    const limit = opts.limit ?? 20;
    const offset = opts.cursor ?? 0;

    const sideFilter =
      actor.role === 'customer'
        ? eq(chatConversations.buyerId, actor.id)
        : eq(chatConversations.shopId, actor.shopId);
    const unreadFilter =
      opts.filter === 'unread'
        ? actor.role === 'customer'
          ? sql`${chatConversations.buyerUnread} > 0`
          : sql`${chatConversations.sellerUnread} > 0`
        : undefined;
    // Search matches the counterpart's display name.
    const searchFilter = opts.q
      ? actor.role === 'customer'
        ? inArray(
            chatConversations.shopId,
            this.db
              .select({ id: shops.id })
              .from(shops)
              .where(ilike(shops.name, `%${opts.q}%`)),
          )
        : inArray(
            chatConversations.buyerId,
            this.db
              .select({ id: users.id })
              .from(users)
              .where(ilike(users.name, `%${opts.q}%`)),
          )
      : undefined;

    const rows = await this.db.query.chatConversations.findMany({
      where: and(sideFilter, unreadFilter, searchFilter),
      with: { shop: true, buyer: true },
      orderBy: [
        desc(
          sql`coalesce(${chatConversations.lastMessageAt}, ${chatConversations.createdAt})`,
        ),
      ],
      limit: limit + 1,
      offset,
    });

    const page = rows.slice(0, limit) as ConversationWithParties[];
    const originMap = await this.resolveOrigins(page);
    return {
      items: page.map((row) => this.toDto(row, actor, originMap)),
      nextCursor: rows.length > limit ? offset + limit : undefined,
    };
  }

  /** Fetch one conversation; 404 unless the caller is a participant. */
  async getById(actor: ChatActor, id: string): Promise<ConversationDto> {
    const row = await this.requireParticipantRow(actor, id);
    const originMap = await this.resolveOrigins([row]);
    return this.toDto(row, actor, originMap);
  }

  /**
   * Start (or return) the thread for (buyer, shop). When an origin is passed
   * and differs from the stored one, the context strip is repointed — the
   * buyer re-entered the thread from a different product/order.
   */
  async start(
    actor: CustomerActor,
    dto: StartConversationDto,
  ): Promise<{ conversation: ConversationDto; created: boolean }> {
    const shop = await this.db.query.shops.findFirst({
      where: eq(shops.id, dto.shopId),
    });
    if (!shop) throw new NotFoundException('Shop not found');

    const inserted = await this.db
      .insert(chatConversations)
      .values({
        buyerId: actor.id,
        shopId: dto.shopId,
        originType: dto.origin?.type ?? null,
        originRefId: dto.origin?.refId ?? null,
      })
      .onConflictDoNothing({
        target: [chatConversations.buyerId, chatConversations.shopId],
      })
      .returning({ id: chatConversations.id });

    const created = inserted.length > 0;
    let row = await this.db.query.chatConversations.findFirst({
      where: and(
        eq(chatConversations.buyerId, actor.id),
        eq(chatConversations.shopId, dto.shopId),
      ),
      with: { shop: true, buyer: true },
    });
    if (!row) throw new NotFoundException('Conversation not found');

    const originChanged =
      !!dto.origin &&
      (row.originType !== dto.origin.type ||
        row.originRefId !== dto.origin.refId);
    if (!created && originChanged && dto.origin) {
      await this.db
        .update(chatConversations)
        .set({ originType: dto.origin.type, originRefId: dto.origin.refId })
        .where(eq(chatConversations.id, row.id));
      row = {
        ...row,
        originType: dto.origin.type,
        originRefId: dto.origin.refId,
      };
    }

    const originMap = await this.resolveOrigins([row]);
    return {
      conversation: this.toDto(row, actor, originMap),
      // The controller uses this to attach the initial product card only when
      // the thread is new or was re-entered from a different product/order.
      created: created || originChanged,
    };
  }

  /** Seller-only: the customer-context panel for one conversation. */
  async context(
    actor: SellerActor,
    conversationId: string,
  ): Promise<CustomerContextDto> {
    const convo = await this.requireParticipantRow(actor, conversationId);

    // The platform's per-shop customer aggregate is keyed by (shop, email);
    // the account links to it through the email captured at checkout.
    const buyerEmail = (convo.buyer.email ?? '').toLowerCase();
    const customer = await this.db.query.customers.findFirst({
      where: and(
        eq(customers.shopId, actor.shopId),
        sql`lower(${customers.email}) = ${buyerEmail}`,
      ),
    });
    const recent = await this.db.query.orders.findMany({
      where: and(
        eq(orders.shopId, actor.shopId),
        sql`lower(${orders.email}) = ${buyerEmail}`,
      ),
      orderBy: [desc(orders.placedAt)],
      limit: 5,
      with: { items: true },
    });

    return {
      customerId: convo.buyerId,
      name: convo.buyer.name,
      city: customer?.city || convo.buyer.addressCity || undefined,
      segment: customer?.segment ?? 'New',
      ordersCount: customer?.ordersCount ?? recent.length,
      totalSpent: centsToDollars(customer?.spentCents ?? 0),
      currency: convo.shop.currency,
      customerSince: (customer?.firstOrderAt ?? undefined)?.toISOString(),
      recentOrders: recent.map((o) => ({
        orderId: o.id,
        displayId: o.reference,
        itemsSummary:
          productLines(o.items)
            .map((i) => `${i.name} ×${i.qty}`)
            .join(', ') || `${o.qty} item${o.qty === 1 ? '' : 's'}`,
        total: centsToDollars(o.totalCents),
        currency: convo.shop.currency,
        status: o.status,
        placedAt: o.placedAt.toISOString(),
      })),
    };
  }

  /**
   * The conversation shop's catalogue, for the product picker. Served by the
   * chat module itself so both roles use one endpoint and the module stays
   * free of the host's product controllers.
   */
  async catalogue(actor: ChatActor, conversationId: string) {
    const convo = await this.requireParticipantRow(actor, conversationId);
    const rows = await this.db.query.products.findMany({
      where: eq(products.shopId, convo.shopId),
      orderBy: [desc(products.createdAt)],
      limit: 100,
    });
    return rows.map((p) => ({
      id: p.id,
      name: p.name,
      price: centsToDollars(p.priceCents),
      currency: convo.shop.currency,
      unit: p.unit,
      emoji: p.emoji,
      tone: p.tone,
      imageUrl: p.images?.[0],
      // The item's own delivery charges, so an offer can start from the
      // numbers the seller already set instead of a blank field.
      deliveryDhaka: centsToDollars(p.deliveryDhakaCents),
      deliveryOutside: centsToDollars(p.deliveryOutsideCents),
    }));
  }

  /** Membership check shared by every per-conversation route. */
  async requireParticipantRow(
    actor: ChatActor,
    id: string,
  ): Promise<ConversationWithParties> {
    const row = await this.db.query.chatConversations.findFirst({
      where: eq(chatConversations.id, id),
      with: { shop: true, buyer: true },
    });
    // 404 (not 403) for non-participants, so ids can't be probed.
    if (
      !row ||
      (actor.role === 'customer'
        ? row.buyerId !== actor.id
        : row.shopId !== actor.shopId)
    ) {
      throw new NotFoundException('Conversation not found');
    }
    return row;
  }

  /** Guard helper for seller-only data. */
  assertSeller(actor: ChatActor): asserts actor is SellerActor {
    if (actor.role !== 'seller') {
      throw new ForbiddenException('Seller-only');
    }
  }

  /** Re-emit a conversation to both sides' rooms (drives the sidebars). */
  async broadcastUpdated(conversationId: string): Promise<void> {
    const row = await this.db.query.chatConversations.findFirst({
      where: eq(chatConversations.id, conversationId),
      with: { shop: true, buyer: true },
    });
    if (!row) return;
    const originMap = await this.resolveOrigins([row]);
    this.realtime.emitTo(
      ChatRealtimeService.room('buyer', row.buyerId),
      'conversation.updated',
      this.toDto(row, { role: 'customer' }, originMap),
    );
    this.realtime.emitTo(
      ChatRealtimeService.room('shop', row.shopId),
      'conversation.updated',
      this.toDto(row, { role: 'seller' }, originMap),
    );
  }

  /* ---------- DTO assembly ---------- */

  /**
   * Batch-resolve origin refs (products/orders) for the context strips —
   * one query per type instead of one per conversation.
   */
  private async resolveOrigins(
    rows: ConversationWithParties[],
  ): Promise<Map<string, ConversationDto['origin']>> {
    const map = new Map<string, ConversationDto['origin']>();
    const productIds = rows
      .filter((r) => r.originType === 'product' && r.originRefId)
      .map((r) => r.originRefId as string);
    const orderIds = rows
      .filter((r) => r.originType === 'order' && r.originRefId)
      .map((r) => r.originRefId as string);

    const productRows = productIds.length
      ? await this.db.query.products.findMany({
          where: inArray(products.id, productIds),
        })
      : [];
    const orderRows = orderIds.length
      ? await this.db.query.orders.findMany({
          where: inArray(orders.id, orderIds),
        })
      : [];

    for (const row of rows) {
      if (!row.originType || !row.originRefId) continue;
      if (row.originType === 'product') {
        const p = productRows.find((x) => x.id === row.originRefId);
        if (!p) continue;
        map.set(row.id, {
          type: 'product',
          refId: p.id,
          title: p.name,
          subtitle: `Conversation started from this product`,
          emoji: p.emoji,
          tone: p.tone,
          url: `/shop/${row.shop.handle}/p/${p.slug}`,
        });
      } else {
        const o = orderRows.find((x) => x.id === row.originRefId);
        if (!o) continue;
        map.set(row.id, {
          type: 'order',
          refId: o.id,
          title: `Order ${o.reference}`,
          subtitle: `This conversation references an order`,
          emoji: '🧾',
          tone: '#e9eefc',
          url: `/shop/${row.shop.handle}`,
        });
      }
    }
    return map;
  }

  private toDto(
    row: ConversationWithParties,
    actor: Pick<ChatActor, 'role'>,
    originMap: Map<string, ConversationDto['origin']>,
  ): ConversationDto {
    const forCustomer = actor.role === 'customer';
    return {
      id: row.id,
      shop: {
        id: row.shop.id,
        name: row.shop.name,
        handle: row.shop.handle,
        brand: row.shop.brand,
        brandSoft: row.shop.brandSoft,
        currency: row.shop.currency,
      },
      customer: { id: row.buyer.id, name: row.buyer.name },
      origin: originMap.get(row.id),
      lastMessage: row.lastMessagePreview ?? undefined,
      unreadCount: forCustomer ? row.buyerUnread : row.sellerUnread,
      counterpartOnline: forCustomer
        ? this.realtime.isOnline('shop', row.shopId)
        : this.realtime.isOnline('buyer', row.buyerId),
      counterpartLastSeenAt: forCustomer
        ? this.realtime.lastSeenAt('shop', row.shopId)
        : this.realtime.lastSeenAt('buyer', row.buyerId),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
