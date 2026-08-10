import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import {
  users,
  chatConversations,
  chatParticipants,
  customers,
  orders,
  products,
  shops,
  type ChatConversationRow,
} from '../../database/schema';
import { centsToDollars } from '../../common/utils/money.util';
import { productLines } from '../../common/utils/order-line.util';
import type { ChatActor, CustomerActor, SellerActor } from './chat-actor';
import { pairKeyFor, partiesOf, type ChatParty } from './chat-parties';
import { writeThreadParticipants } from './thread-participants.util';
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
  /**
   * The other party, from this viewer's seat. A shop owner is the shop in one
   * thread and the buyer in the next, so a list cannot label rows by the
   * viewer's role - it has to name whoever is across from them.
   */
  counterpart: { kind: 'shop' | 'account' | 'support'; id: string; name: string };
  origin?: {
    type: 'product' | 'order';
    refId: string;
    title: string;
    subtitle: string;
    emoji: string;
    tone: string;
    /** Host-app link behind the origin menu's "view details". */
    url: string;
    /** Product origins only - enough for the origin menu to show the item
     * as a card rather than an emoji and a name. */
    imageUrl?: string;
    price?: number;
    unit?: string;
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

    // "Threads I am a participant in". A shop owner speaks as two parties -
    // themselves and their storefront - so this one query is what makes their
    // inbox the same list in the console and on their storefront profile,
    // rather than two inboxes kept in step.
    const parties = await this.partySetFor(actor);
    const sideFilter = inArray(
      chatConversations.id,
      this.db
        .select({ id: chatParticipants.conversationId })
        .from(chatParticipants)
        .where(
          or(
            ...parties.map((p) =>
              p.kind === 'account'
                ? and(
                    eq(chatParticipants.kind, 'account'),
                    eq(chatParticipants.accountId, p.id as string),
                  )
                : and(
                    eq(chatParticipants.kind, 'shop'),
                    eq(chatParticipants.shopId, p.id as string),
                  ),
            ),
          ),
        ),
    );
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
    const unread = await this.unreadFor(page.map((r) => r.id), parties);
    return {
      items: page.map((row) => this.toDto(row, actor, originMap, unread.get(row.id))),
      nextCursor: rows.length > limit ? offset + limit : undefined,
    };
  }

  /** Fetch one conversation; 404 unless the caller is a participant. */
  async getById(actor: ChatActor, id: string): Promise<ConversationDto> {
    const row = await this.requireParticipantRow(actor, id);
    const originMap = await this.resolveOrigins([row]);
    const unread = await this.unreadFor([row.id], await this.partySetFor(actor));
    return this.toDto(row, actor, originMap, unread.get(row.id));
  }

  /**
   * Start (or return) the thread for (buyer, shop). When an origin is passed
   * and differs from the stored one, the context strip is repointed - the
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

    const buyerParty: ChatParty = { kind: 'account', id: actor.id };
    const shopParty: ChatParty = { kind: 'shop', id: dto.shopId };
    const inserted = await this.db
      .insert(chatConversations)
      .values({
        buyerId: actor.id,
        shopId: dto.shopId,
        pairKey: pairKeyFor(buyerParty, shopParty),
        originType: dto.origin?.type ?? null,
        originRefId: dto.origin?.refId ?? null,
      })
      .onConflictDoNothing({
        target: [chatConversations.buyerId, chatConversations.shopId],
      })
      .returning({ id: chatConversations.id });

    // Every thread carries its two participants, so an inbox is one query over
    // the parties a viewer speaks as rather than a union of special cases.
    if (inserted[0]) {
      await writeThreadParticipants(this.db, inserted[0].id, buyerParty, shopParty);
    }

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
      hasVariants: (p.variantCombinations ?? []).length > 0,
      // The item's own delivery charges, so an offer can start from the
      // numbers the seller already set instead of a blank field.
      deliveryDhaka: centsToDollars(p.deliveryDhakaCents),
      deliveryOutside: centsToDollars(p.deliveryOutsideCents),
    }));
  }

  /** Does this viewer speak as either side of the thread? */
  private async isParticipant(
    actor: ChatActor,
    row: ChatConversationRow,
  ): Promise<boolean> {
    const parties = await this.partySetFor(actor);
    const sides = await this.db.query.chatParticipants.findMany({
      where: eq(chatParticipants.conversationId, row.id),
      columns: { kind: true, accountId: true, shopId: true },
    });
    // Threads created before participants existed are matched on the columns
    // they were written with, so nothing is locked out mid-migration.
    if (!sides.length) {
      return actor.role === 'customer'
        ? row.buyerId === actor.id
        : row.shopId === actor.shopId;
    }
    return sides.some((side) =>
      parties.some((p) =>
        p.kind === 'account'
          ? side.kind === 'account' && side.accountId === p.id
          : side.kind === 'shop' && side.shopId === p.id,
      ),
    );
  }

  /**
   * Every party this viewer speaks as.
   *
   * A shop owner is themselves *and* their storefront, from either side of the
   * platform - which is what makes their inbox one list whether they open it
   * in the console or on their storefront profile.
   *
   * Invited staff are only ever the shop: an owner's conversations with other
   * shops are their own business, and a console token must not open them.
   */
  async partySetFor(actor: ChatActor): Promise<ChatParty[]> {
    if (actor.role === 'customer') {
      const owned = await this.db.query.shops.findMany({
        where: eq(shops.ownerId, actor.id),
        columns: { id: true },
      });
      return partiesOf(actor, { ownedShopIds: owned.map((s) => s.id) });
    }
    const shop = await this.db.query.shops.findFirst({
      where: eq(shops.id, actor.shopId),
      columns: { ownerId: true },
    });
    // The seller actor's id is an admin-user id; it equals the owner's account
    // id only on the owner's own auto-elevated console session.
    const ownerAccountId =
      shop && shop.ownerId === actor.id ? shop.ownerId : null;
    return partiesOf(actor, { ownerAccountId });
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
    // Same rule the inbox lists by, so a thread that appears in the list can
    // always be opened - and one that does not, cannot.
    // 404 (not 403) for non-participants, so ids can't be probed.
    if (!row || !(await this.isParticipant(actor, row))) {
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
   * Batch-resolve origin refs (products/orders) for the context strips -
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
          imageUrl: p.images?.[0],
          price: centsToDollars(p.priceCents),
          unit: p.unit,
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

  /**
   * How many messages each of these threads holds unread *for this viewer*.
   *
   * Read from their own participant row: a shop owner is the buyer in one
   * thread and the shop in the next, and the pair of counters on the
   * conversation cannot say which of those a number belongs to.
   */
  private async unreadFor(
    conversationIds: string[],
    parties: ChatParty[],
  ): Promise<Map<string, { unread: number; side: string }>> {
    const out = new Map<string, { unread: number; side: string }>();
    if (!conversationIds.length) return out;
    const rows = await this.db.query.chatParticipants.findMany({
      where: inArray(chatParticipants.conversationId, conversationIds),
    });
    for (const row of rows) {
      const mine = parties.some((p) =>
        p.kind === 'account'
          ? row.kind === 'account' && row.accountId === p.id
          : p.kind === 'shop'
            ? row.kind === 'shop' && row.shopId === p.id
            : row.kind === 'support',
      );
      if (mine) out.set(row.conversationId, { unread: row.unread, side: row.side });
    }
    return out;
  }

  private toDto(
    row: ConversationWithParties,
    actor: Pick<ChatActor, 'role'>,
    originMap: Map<string, ConversationDto['origin']>,
    /** This viewer's own side; absent on threads predating participants. */
    mine?: { unread: number; side: string },
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
      counterpart:
        (mine ? mine.side === 'a' : forCustomer)
          ? { kind: 'shop', id: row.shop.id, name: row.shop.name }
          : { kind: 'account', id: row.buyer.id, name: row.buyer.name },
      origin: originMap.get(row.id),
      lastMessage: row.lastMessagePreview ?? undefined,
      // Falls back to the legacy pair only for threads with no participant
      // rows yet, where the viewer can only be the buyer or the shop anyway.
      unreadCount:
        mine?.unread ?? (forCustomer ? row.buyerUnread : row.sellerUnread),
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
