import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, gt, ilike, inArray, not, or, sql } from 'drizzle-orm';
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
  type ChatParticipantRow,
} from '../../database/schema';
import { centsToDollars } from '../../common/utils/money.util';
import { productLines } from '../../common/utils/order-line.util';
import type { ChatActor, CustomerActor, SellerActor } from './chat-actor';
import {
  pairKeyFor,
  partiesOf,
  partyKey,
  type ChatParty,
} from './chat-parties';
import { isParty } from './participant-unread.util';
import {
  SUPPORT_EMAIL,
  SUPPORT_NAME,
  SUPPORT_PARTY_ID,
} from './support.constants';
import { writeThreadParticipants } from './thread-participants.util';
import { ChatRealtimeService } from './chat-realtime.service';
import type { StartConversationDto } from './dto/chat.dto';

/** Caller-scoped conversation payload (unread counts are per-side). */
export interface ConversationDto {
  id: string;
  /** The storefront side, when the thread has one. */
  shop?: {
    id: string;
    name: string;
    handle: string;
    brand: string;
    brandSoft: string;
    currency: string;
  };
  /** The buyer side, when the thread has one. */
  customer?: { id: string; name: string };
  /**
   * The other party, from this viewer's seat. A shop owner is the shop in one
   * thread and the buyer in the next, so a list cannot label rows by the
   * viewer's role - it has to name whoever is across from them.
   */
  counterpart: {
    kind: 'shop' | 'account' | 'support';
    id: string;
    name: string;
    /** Optional second line, currently used for the verified support address. */
    subtitle?: string;
  };
  /** Participant slot occupied by this viewer in this thread. */
  currentSide?: 'a' | 'b';
  /** Party this viewer represents in this particular thread. */
  currentParty?: { kind: 'shop' | 'account' | 'support'; id: string };
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
    senderRole: 'customer' | 'seller' | 'support';
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
  /** Absent on threads with no shop side (support↔account, account↔account). */
  shop: typeof shops.$inferSelect | null;
  /** Absent on threads with no buyer side (support↔shop). */
  buyer: typeof users.$inferSelect | null;
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
                : p.kind === 'shop'
                  ? and(
                      eq(chatParticipants.kind, 'shop'),
                      eq(chatParticipants.shopId, p.id as string),
                    )
                  : // One desk: every support thread belongs to it.
                    eq(chatParticipants.kind, 'support'),
            ),
          ),
        ),
    );
    const mine = or(
      ...parties.map((p) =>
        p.kind === 'account'
          ? and(
              eq(chatParticipants.kind, 'account'),
              eq(chatParticipants.accountId, p.id as string),
            )
          : p.kind === 'shop'
            ? and(
                eq(chatParticipants.kind, 'shop'),
                eq(chatParticipants.shopId, p.id as string),
              )
            : eq(chatParticipants.kind, 'support'),
      ),
    );
    const unreadFilter =
      opts.filter === 'unread'
        ? inArray(
            chatConversations.id,
            this.db
              .select({ id: chatParticipants.conversationId })
              .from(chatParticipants)
              .where(and(mine, gt(chatParticipants.unread, 0))),
          )
        : undefined;
    // Search the participant across from the viewer. This cannot be based on
    // the viewer's role: an owner is an account in one row and a shop in the
    // next, and account↔account has no fixed "buyer" column at all.
    const q = opts.q?.trim();
    const nameMatch = q
      ? or(
          and(
            eq(chatParticipants.kind, 'account'),
            inArray(
              chatParticipants.accountId,
              this.db
                .select({ id: users.id })
                .from(users)
                .where(ilike(users.name, `%${q}%`)),
            ),
          ),
          and(
            eq(chatParticipants.kind, 'shop'),
            inArray(
              chatParticipants.shopId,
              this.db
                .select({ id: shops.id })
                .from(shops)
                .where(ilike(shops.name, `%${q}%`)),
            ),
          ),
          ...(SUPPORT_NAME.toLowerCase().includes(q.toLowerCase())
            ? [eq(chatParticipants.kind, 'support')]
            : []),
        )
      : undefined;
    const searchFilter = nameMatch
      ? inArray(
          chatConversations.id,
          this.db
            .select({ id: chatParticipants.conversationId })
            .from(chatParticipants)
            .where(and(not(mine!), nameMatch)),
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
    const sides = await this.sidesFor(
      page.map((r) => r.id),
      parties,
    );
    const names = await this.namesFor(
      [...sides.values()]
        .map((v) => v.theirs)
        .filter((v): v is ChatParticipantRow => !!v),
    );
    return {
      items: page.map((row) =>
        this.toDto(row, actor, originMap, sides.get(row.id), names),
      ),
      nextCursor: rows.length > limit ? offset + limit : undefined,
    };
  }

  /** Fetch one conversation; 404 unless the caller is a participant. */
  async getById(actor: ChatActor, id: string): Promise<ConversationDto> {
    const row = await this.requireParticipantRow(actor, id);
    const originMap = await this.resolveOrigins([row]);
    const sides = await this.sidesFor([row.id], await this.partySetFor(actor));
    const names = await this.namesFor(
      [sides.get(row.id)?.theirs].filter((v): v is ChatParticipantRow => !!v),
    );
    return this.toDto(row, actor, originMap, sides.get(row.id), names);
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
    if (!shop?.live) throw new NotFoundException('Shop not found');
    if (shop.ownerId === actor.id) {
      throw new BadRequestException(
        'You cannot start a chat with your own shop',
      );
    }

    // Origin ids are client input. Validate ownership before storing them or
    // an arbitrary order UUID could make another customer's reference appear
    // in this thread's header.
    if (dto.origin?.type === 'product') {
      const product = await this.db.query.products.findFirst({
        where: and(
          eq(products.id, dto.origin.refId),
          eq(products.shopId, dto.shopId),
        ),
        columns: { id: true },
      });
      if (!product)
        throw new BadRequestException('Invalid conversation origin');
    }
    if (dto.origin?.type === 'order') {
      const order = await this.db.query.orders.findFirst({
        where: and(
          eq(orders.id, dto.origin.refId),
          eq(orders.shopId, dto.shopId),
          sql`lower(${orders.email}) = ${actor.email.toLowerCase()}`,
        ),
        columns: { id: true },
      });
      if (!order) throw new BadRequestException('Invalid conversation origin');
    }

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
      .onConflictDoNothing({ target: chatConversations.pairKey })
      .returning({ id: chatConversations.id });

    // Every thread carries its two participants, so an inbox is one query over
    // the parties a viewer speaks as rather than a union of special cases.
    if (inserted[0]) {
      await writeThreadParticipants(
        this.db,
        inserted[0].id,
        buyerParty,
        shopParty,
      );
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
    await writeThreadParticipants(this.db, row.id, buyerParty, shopParty);

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
    const sides = await this.sidesFor([row.id], await this.partySetFor(actor));
    const names = await this.namesFor(
      [sides.get(row.id)?.theirs].filter((v): v is ChatParticipantRow => !!v),
    );
    return {
      conversation: this.toDto(row, actor, originMap, sides.get(row.id), names),
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
    // The panel describes a shopper. A thread with no buyer side - Hoomri
    // Support writing to a shop - has no shopper to describe.
    if (!convo.buyer || !convo.buyerId || !convo.shop) {
      throw new NotFoundException('This conversation has no customer');
    }

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

    const shop = convo.shop;
    return {
      customerId: convo.buyerId,
      name: convo.buyer.name,
      city: customer?.city || convo.buyer.addressCity || undefined,
      segment: customer?.segment ?? 'New',
      ordersCount: customer?.ordersCount ?? recent.length,
      totalSpent: centsToDollars(customer?.spentCents ?? 0),
      currency: shop.currency,
      customerSince: (customer?.firstOrderAt ?? undefined)?.toISOString(),
      recentOrders: recent.map((o) => ({
        orderId: o.id,
        displayId: o.reference,
        itemsSummary:
          productLines(o.items)
            .map((i) => `${i.name} ×${i.qty}`)
            .join(', ') || `${o.qty} item${o.qty === 1 ? '' : 's'}`,
        total: centsToDollars(o.totalCents),
        currency: shop.currency,
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
    // A catalogue belongs to a storefront; a thread without one has nothing
    // to pick from.
    if (!convo.shop || !convo.shopId) return [];
    const catalogueShop = convo.shop;
    const rows = await this.db.query.products.findMany({
      where: eq(products.shopId, convo.shopId),
      orderBy: [desc(products.createdAt)],
      limit: 100,
    });
    return rows.map((p) => ({
      id: p.id,
      name: p.name,
      price: centsToDollars(p.priceCents),
      currency: catalogueShop.currency,
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
      // Pre-participants threads are buyer↔shop by definition, so support has
      // no claim on one.
      if (actor.role === 'support') return false;
      return actor.role === 'customer'
        ? row.buyerId === actor.id
        : row.shopId === actor.shopId;
    }
    return sides.some((side) =>
      parties.some((p) => isParty(side as ChatParticipantRow, p)),
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
    if (actor.role === 'support') return partiesOf(actor);
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

  /**
   * Open (or return) the thread between the caller and one other party.
   *
   * The generalised form of `start`: the pair is the identity, so this is the
   * one path that can express Hoomri Support writing to a shop, a seller
   * writing to a person, or two people talking - none of which have both a
   * buyer and a shop to key on.
   */
  async startWithParty(
    actor: ChatActor,
    target: ChatParty,
    preferAccount = false,
  ): Promise<{ conversation: ConversationDto; created: boolean }> {
    const myParties = await this.partySetFor(actor);
    const mine = preferAccount
      ? (myParties.find((p) => p.kind === 'account') ?? myParties[0])
      : myParties[0];
    if (!mine) throw new ForbiddenException('No party to speak as');
    if (myParties.some((p) => partyKey(p) === partyKey(target))) {
      throw new BadRequestException('You cannot start a thread with yourself');
    }
    // Direct support routes arrive by id rather than handle. Resolve every
    // target before insert so a stale/guessed id returns a clean 404 instead
    // of surfacing a foreign-key error as a server failure.
    if (target.kind === 'shop') {
      const shop = await this.db.query.shops.findFirst({
        where: eq(shops.id, target.id as string),
        columns: { id: true },
      });
      if (!shop) throw new NotFoundException('Shop not found');
    } else if (target.kind === 'account') {
      const account = await this.db.query.users.findFirst({
        where: eq(users.id, target.id as string),
        columns: { id: true },
      });
      if (!account) throw new NotFoundException('Account not found');
    }
    if (mine.kind === 'account' && target.kind === 'account') {
      const account = await this.db.query.users.findFirst({
        where: eq(users.id, mine.id as string),
        columns: { emailVerified: true, phoneVerified: true },
      });
      const ownsShop = await this.db.query.shops.findFirst({
        where: eq(shops.ownerId, mine.id as string),
        columns: { id: true },
      });
      if (
        !account ||
        (!account.emailVerified && !account.phoneVerified && !ownsShop)
      ) {
        throw new ForbiddenException(
          'Verify your email or phone before messaging another person',
        );
      }
    }

    const pairKey = pairKeyFor(mine, target);
    const existing = await this.db.query.chatConversations.findFirst({
      where: eq(chatConversations.pairKey, pairKey),
      with: { shop: true, buyer: true },
    });

    let row = existing ?? null;
    if (!row) {
      // buyer_id / shop_id stay meaningful for the classic pair, because they
      // are what cascade the thread away with the account or the shop.
      const classic =
        [mine, target].some((p) => p.kind === 'account') &&
        [mine, target].some((p) => p.kind === 'shop');
      const account = classic
        ? [mine, target].find((p) => p.kind === 'account')
        : undefined;
      const shop = [mine, target].find((p) => p.kind === 'shop');
      const [inserted] = await this.db
        .insert(chatConversations)
        .values({
          pairKey,
          buyerId: account?.id ?? null,
          shopId: shop?.id ?? null,
        })
        .onConflictDoNothing({ target: chatConversations.pairKey })
        .returning({ id: chatConversations.id });
      if (inserted) {
        await writeThreadParticipants(this.db, inserted.id, mine, target);
      }
      row =
        (await this.db.query.chatConversations.findFirst({
          where: eq(chatConversations.pairKey, pairKey),
          with: { shop: true, buyer: true },
        })) ?? null;
    }
    if (!row) throw new NotFoundException('Conversation not found');
    // Also repairs a row left between conversation insert and participant
    // insert by an interrupted deployment/process.
    await writeThreadParticipants(this.db, row.id, mine, target);

    const originMap = await this.resolveOrigins([row]);
    const sides = await this.sidesFor([row.id], await this.partySetFor(actor));
    const names = await this.namesFor(
      [sides.get(row.id)?.theirs].filter((v): v is ChatParticipantRow => !!v),
    );
    return {
      conversation: this.toDto(row, actor, originMap, sides.get(row.id), names),
      created: !existing,
    };
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
    const participants = await this.db.query.chatParticipants.findMany({
      where: eq(chatParticipants.conversationId, conversationId),
    });
    if (participants.length === 2) {
      const names = await this.namesFor(participants);
      for (const mine of participants) {
        const theirs = participants.find((p) => p.side !== mine.side);
        const party: ChatParty = {
          kind: mine.kind,
          id:
            mine.kind === 'account'
              ? mine.accountId
              : mine.kind === 'shop'
                ? mine.shopId
                : null,
        };
        this.realtime.emitTo(
          ChatRealtimeService.partyRoom(party),
          'conversation.updated',
          this.toDto(
            row,
            {
              role:
                mine.kind === 'shop'
                  ? 'seller'
                  : mine.kind === 'support'
                    ? 'support'
                    : 'customer',
            },
            originMap,
            { mine, theirs },
            names,
          ),
        );
      }
      return;
    }
    // Compatibility for a row created before the participant backfill.
    if (row.buyerId) {
      this.realtime.emitTo(
        ChatRealtimeService.room('buyer', row.buyerId),
        'conversation.updated',
        this.toDto(row, { role: 'customer' }, originMap),
      );
    }
    if (row.shopId) {
      this.realtime.emitTo(
        ChatRealtimeService.room('shop', row.shopId),
        'conversation.updated',
        this.toDto(row, { role: 'seller' }, originMap),
      );
    }
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
          url: row.shop ? `/shop/${row.shop.handle}/p/${p.slug}` : '',
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
          url: row.shop ? `/shop/${row.shop.handle}` : '',
        });
      }
    }
    return map;
  }

  /**
   * This viewer's own side of each thread, and the side across from them.
   *
   * Both come from the participant rows, which are the only description that
   * fits every thread shape: a support thread has no buyer to fall back on,
   * and a thread between two people has two accounts, so "the other one"
   * cannot be guessed from the legacy columns.
   */
  private async sidesFor(
    conversationIds: string[],
    parties: ChatParty[],
  ): Promise<
    Map<string, { mine?: ChatParticipantRow; theirs?: ChatParticipantRow }>
  > {
    const out = new Map<
      string,
      { mine?: ChatParticipantRow; theirs?: ChatParticipantRow }
    >();
    if (!conversationIds.length) return out;
    const rows = await this.db.query.chatParticipants.findMany({
      where: inArray(chatParticipants.conversationId, conversationIds),
    });
    for (const row of rows) {
      const entry = out.get(row.conversationId) ?? {};
      if (parties.some((p) => isParty(row, p))) entry.mine = row;
      else entry.theirs = row;
      out.set(row.conversationId, entry);
    }
    return out;
  }

  /** Display names for a set of participant rows, in two queries. */
  private async namesFor(
    sides: ChatParticipantRow[],
  ): Promise<{ shops: Map<string, string>; accounts: Map<string, string> }> {
    const shopIds = [
      ...new Set(sides.map((s) => s.shopId).filter((id): id is string => !!id)),
    ];
    const accountIds = [
      ...new Set(
        sides.map((s) => s.accountId).filter((id): id is string => !!id),
      ),
    ];
    const [shopRows, accountRows] = await Promise.all([
      shopIds.length
        ? this.db.query.shops.findMany({
            where: inArray(shops.id, shopIds),
            columns: { id: true, name: true },
          })
        : Promise.resolve([] as { id: string; name: string }[]),
      accountIds.length
        ? this.db.query.users.findMany({
            where: inArray(users.id, accountIds),
            columns: { id: true, name: true },
          })
        : Promise.resolve([] as { id: string; name: string }[]),
    ]);
    return {
      shops: new Map<string, string>(
        shopRows.map((r): [string, string] => [r.id, r.name]),
      ),
      accounts: new Map<string, string>(
        accountRows.map((r): [string, string] => [r.id, r.name]),
      ),
    };
  }

  /**
   * Who is across from this viewer.
   *
   * Read from the other participant row, which is the only thing that names
   * the right party in every shape - the legacy columns cannot tell one
   * account from the other, and a support thread has neither.
   */
  private counterpartOf(
    row: ConversationWithParties,
    sides:
      | { mine?: ChatParticipantRow; theirs?: ChatParticipantRow }
      | undefined,
    names:
      | { shops: Map<string, string>; accounts: Map<string, string> }
      | undefined,
    forCustomer: boolean,
  ): ConversationDto['counterpart'] {
    const theirs = sides?.theirs;
    if (theirs) {
      if (theirs.kind === 'support') {
        return {
          kind: 'support',
          id: SUPPORT_PARTY_ID,
          name: SUPPORT_NAME,
          subtitle: SUPPORT_EMAIL,
        };
      }
      if (theirs.kind === 'shop' && theirs.shopId) {
        return {
          kind: 'shop',
          id: theirs.shopId,
          name: names?.shops.get(theirs.shopId) ?? row.shop?.name ?? '',
        };
      }
      if (theirs.kind === 'account' && theirs.accountId) {
        return {
          kind: 'account',
          id: theirs.accountId,
          name: names?.accounts.get(theirs.accountId) ?? row.buyer?.name ?? '',
        };
      }
    }
    // Threads written before participants existed are buyer↔shop, so the
    // viewer's role still identifies the other side.
    return forCustomer && row.shop
      ? { kind: 'shop', id: row.shop.id, name: row.shop.name }
      : row.buyer
        ? { kind: 'account', id: row.buyer.id, name: row.buyer.name }
        : {
            kind: 'support',
            id: SUPPORT_PARTY_ID,
            name: SUPPORT_NAME,
            subtitle: SUPPORT_EMAIL,
          };
  }

  private toDto(
    row: ConversationWithParties,
    actor: Pick<ChatActor, 'role'>,
    originMap: Map<string, ConversationDto['origin']>,
    /** This viewer's side and the other one; absent on pre-participant rows. */
    sides?: { mine?: ChatParticipantRow; theirs?: ChatParticipantRow },
    names?: { shops: Map<string, string>; accounts: Map<string, string> },
  ): ConversationDto {
    const forCustomer = actor.role === 'customer';
    const counterpart = this.counterpartOf(row, sides, names, forCustomer);
    return {
      id: row.id,
      ...(row.shop && {
        shop: {
          id: row.shop.id,
          name: row.shop.name,
          handle: row.shop.handle,
          brand: row.shop.brand,
          brandSoft: row.shop.brandSoft,
          currency: row.shop.currency,
        },
      }),
      ...(row.buyer && {
        customer: { id: row.buyer.id, name: row.buyer.name },
      }),
      counterpart,
      currentSide: sides?.mine?.side as 'a' | 'b' | undefined,
      currentParty: sides?.mine
        ? {
            kind: sides.mine.kind,
            id:
              sides.mine.kind === 'account'
                ? (sides.mine.accountId as string)
                : sides.mine.kind === 'shop'
                  ? (sides.mine.shopId as string)
                  : SUPPORT_PARTY_ID,
          }
        : undefined,
      origin: originMap.get(row.id),
      lastMessage: row.lastMessagePreview ?? undefined,
      // Falls back to the legacy pair only for threads with no participant
      // rows yet, where the viewer can only be the buyer or the shop anyway.
      unreadCount:
        sides?.mine?.unread ??
        (forCustomer ? row.buyerUnread : row.sellerUnread),
      // Presence follows the counterpart the DTO just named, so it stays right
      // for a viewer who is the shop in one thread and the buyer in the next.
      counterpartOnline: this.realtime.isPartyOnline({
        kind: counterpart.kind,
        id: counterpart.kind === 'support' ? null : counterpart.id,
      }),
      counterpartLastSeenAt: this.realtime.partyLastSeenAt({
        kind: counterpart.kind,
        id: counterpart.kind === 'support' ? null : counterpart.id,
      }),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
