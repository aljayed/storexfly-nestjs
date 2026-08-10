import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { users } from './users.schema';
import { shops } from './shops.schema';

/**
 * Hoomri Chat - customer ↔ seller messaging (see design_handoff_hoomri_chat).
 * Deliberately self-contained: every chat table is prefixed `chat_` and the
 * only links into the platform schema are the two participant FKs, so the
 * module can be lifted into another project by swapping those references.
 */

export const chatOriginTypeEnum = pgEnum('chat_origin_type', [
  'product',
  'order',
]);

/** Which side of the conversation authored a message. */
export const chatSenderRoleEnum = pgEnum('chat_sender_role', [
  'customer',
  'seller',
  'support',
]);

/**
 * What a conversation participant *is*. A thread is a pair of these, which is
 * what lets chat carry more than the original buyer↔shop case:
 *
 *   account ↔ shop      the classic thread - a buyer messaging a storefront
 *   account ↔ account   two people, neither acting as a shop
 *   support ↔ shop      Hoomri Support messaging a seller's console
 *   support ↔ account   Hoomri Support messaging any account
 *
 * `support` is the platform's own desk (contact@hoomri.com). It is a kind
 * rather than a row: there is exactly one of it, so it carries no id.
 */
export const chatPartyKindEnum = pgEnum('chat_party_kind', [
  'account',
  'shop',
  'support',
]);

export const chatMessageTypeEnum = pgEnum('chat_message_type', [
  'text',
  'product',
  'order',
  'image',
  'file',
  'system',
  // A shop-initiated order-amount change card. A decrease is auto-applied and
  // informational; an increase is an approval card the buyer acts on in-chat.
  'adjustment',
  // A shop-initiated order offer: the seller proposes items at a price they
  // set, and accepting it places the order. See `chatOrderOffers`.
  'offer',
]);

/** sent → delivered (recipient connected) → read. `sending` is client-only. */
export const chatMessageStatusEnum = pgEnum('chat_message_status', [
  'sent',
  'delivered',
  'read',
]);

/** Denormalized sidebar snippet, updated with every message insert. */
export interface ChatMessagePreviewValue {
  type: ChatMessageType;
  text: string;
  senderRole: ChatSenderRole;
  senderSide?: 'a' | 'b';
  sentAt: string;
}

/**
 * Point-in-time copy of a product embedded in a product-card message - a
 * snapshot, not a live join, because catalog rows change and get deleted.
 * Price is decimal (same shape the REST product endpoints expose).
 */
export interface ChatProductSnapshotValue {
  productId: string;
  shopId: string;
  name: string;
  slug: string;
  price: number;
  currency: string;
  unit: string;
  emoji: string;
  tone: string;
  imageUrl?: string;
}

/** Point-in-time copy of an order embedded in an order-reference message. */
export interface ChatOrderSnapshotValue {
  orderId: string;
  displayId: string; // human reference, e.g. "#1042"
  itemsSummary: string;
  total: number;
  currency: string;
  status: string;
}

/** One ordered line shown on an adjustment card, so the buyer can see what
 *  the amount they are approving is actually for. Money in major units. */
export interface ChatAdjustmentItemValue {
  name: string;
  qty: number;
  /** What was picked at purchase time ("Size: L · Pack of 3"), when any. */
  variant?: string;
  /** Unit price × qty. */
  lineTotal: number;
  imageUrl?: string;
  emoji?: string;
  tone?: string;
  /** Product page slug - absent once the product is deleted. */
  slug?: string;
}

/**
 * A shop-initiated order-amount change embedded in an 'adjustment' card. A
 * `decrease` is auto-applied (status 'approved') and purely informational; an
 * `increase` starts 'pending' and the buyer approves/declines from the card.
 * Totals are decimal (major units). Kept as a snapshot like the other cards.
 *
 * Everything below `status` is order context the card renders to explain what
 * is being changed. All of it is optional: cards posted before the card grew
 * those fields simply render the amounts, as they always did.
 */
export interface ChatAdjustmentSnapshotValue {
  adjustmentId: string;
  displayId: string; // order human reference, e.g. "#1042"
  previousTotal: number;
  newTotal: number;
  reason: string;
  currency: string;
  direction: 'increase' | 'decrease';
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  /** The first few product lines of the order (never the shipping/discount
      rows), plus the count of what was left out. */
  items?: ChatAdjustmentItemValue[];
  /** Product lines beyond the ones in `items`. */
  moreItems?: number;
  /** Units ordered across every product line. */
  itemCount?: number;
  /** Shipping charge, already inside both totals (0 = free delivery). */
  delivery?: number;
  /** ISO date the order was placed. */
  placedAt?: string;
  /** Fulfilment status when the change was proposed ('New', 'Packed', …). */
  orderStatus?: string;
  /** Payment-method code and its catalogue title at the time ('cod' /
      'Cash on Delivery') - the buyer still owes this money. */
  paymentMethod?: string;
  paymentLabel?: string;
}

/**
 * Card summary of an order offer. Deliberately small - enough to render the
 * bubble with a total and a status; the View screen fetches the full offer,
 * which is the authoritative copy (see `chatOrderOffers`).
 */
export interface ChatOfferSnapshotValue {
  offerId: string;
  /** "2 × Alphonso Mango Box + 1 more" - precomputed for the bubble. */
  itemsSummary: string;
  itemCount: number;
  total: number;
  currency: string;
  status: ChatOfferStatus;
  /** ISO date; absent = the offer does not expire. */
  expiresAt?: string;
  /** Cover of the first line, so the card shows what's being offered.
      Absent on offers sent before cards carried an image. */
  imageUrl?: string;
  emoji?: string;
  tone?: string;
  /** First line's slug and video - the card links to the product page, and
      falls back to the video's still when the item has no photo. */
  slug?: string;
  videoUrl?: string;
  /** True when every item on the offer delivers free, so the card can say so
      without knowing where the buyer is. Otherwise delivery is unknown until
      they confirm their district on the View screen. */
  freeDelivery?: boolean;
}

/** Inline attachment (data URL, same storage approach as product images). */
export interface ChatAttachmentValue {
  kind: 'image' | 'file';
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  dataUrl: string;
}

/**
 * One thread per (buyer, shop) pair, reused across products and orders.
 * Unread counts are denormalized per side and updated transactionally with
 * each message insert.
 */
export const chatConversations = pgTable(
  'chat_conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * The two participants, normalised into one sorted key
     * (`account:<uuid>|shop:<uuid>`, `support:|account:<uuid>`, …) so a thread
     * can be looked up by its pair regardless of who opened it. The parties
     * themselves live in {@link chatParticipants}; this is the unique handle.
     */
    pairKey: varchar('pair_key', { length: 160 }).notNull(),
    /**
     * Set only on buyer↔shop threads, which is what they are for: the foreign
     * keys that cascade a thread away when the account or the shop is deleted.
     * A support thread has no buyer and a person-to-person thread has no shop,
     * so both are null there - {@link chatParticipants} is what every reader
     * goes through, and these are the delete rules.
     */
    buyerId: uuid('buyer_id').references(() => users.id, {
      onDelete: 'cascade',
    }),
    shopId: uuid('shop_id').references(() => shops.id, { onDelete: 'cascade' }),
    // What started (or most recently re-entered) the thread - drives the
    // context strip under the thread header.
    originType: chatOriginTypeEnum('origin_type'),
    originRefId: uuid('origin_ref_id'),
    buyerUnread: integer('buyer_unread').notNull().default(0),
    sellerUnread: integer('seller_unread').notNull().default(0),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    lastMessagePreview: jsonb(
      'last_message_preview',
    ).$type<ChatMessagePreviewValue>(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('chat_conversations_pair_key_unique_idx').on(table.pairKey),
    index('chat_conversations_shop_idx').on(table.shopId),
    index('chat_conversations_buyer_idx').on(table.buyerId),
  ],
);

/**
 * The two sides of a thread, one row each ('a' and 'b').
 *
 * Polymorphic participants normally cost referential integrity - a single
 * `party_id` column can't point at two tables. Keeping one nullable FK per
 * kind, with a CHECK that exactly the right one is set, buys the integrity
 * back: deleting an account or a shop still cascades its threads away.
 *
 * Unread lives here rather than on the conversation because "unread for whom"
 * is a property of a participant, and account↔account threads have no
 * buyer/seller side to hang it off.
 */
export const chatParticipants = pgTable(
  'chat_participants',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => chatConversations.id, { onDelete: 'cascade' }),
    /** 'a' or 'b' - which slot of the pair. Ordering matches `pair_key`. */
    side: varchar('side', { length: 1 }).notNull(),
    kind: chatPartyKindEnum('kind').notNull(),
    accountId: uuid('account_id').references(() => users.id, {
      onDelete: 'cascade',
    }),
    shopId: uuid('shop_id').references(() => shops.id, { onDelete: 'cascade' }),
    unread: integer('unread').notNull().default(0),
    /** Cleared when this side opens the thread; drives read receipts. */
    lastReadAt: timestamp('last_read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('chat_participants_conversation_side_idx').on(
      table.conversationId,
      table.side,
    ),
    index('chat_participants_account_idx').on(table.accountId),
    index('chat_participants_shop_idx').on(table.shopId),
    check('chat_participants_side_check', sql`${table.side} in ('a', 'b')`),
    check(
      'chat_participants_kind_ref_check',
      sql`(${table.kind} = 'account' and ${table.accountId} is not null and ${table.shopId} is null)
          or (${table.kind} = 'shop' and ${table.shopId} is not null and ${table.accountId} is null)
          or (${table.kind} = 'support' and ${table.accountId} is null and ${table.shopId} is null)`,
    ),
  ],
);

export const chatMessages = pgTable(
  'chat_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => chatConversations.id, { onDelete: 'cascade' }),
    senderRole: chatSenderRoleEnum('sender_role').notNull(),
    // Buyer id for customers; admin-user id for sellers (any staff member of
    // the shop replies on its behalf); the support desk's fixed id for Hoomri
    // Support, which is one desk rather than one row per operator.
    senderId: uuid('sender_id').notNull(),
    /** Participant slot that authored the message. Unlike senderRole this is
     * stable when a shop owner opens the same merged inbox from their account
     * profile and from the shop console. */
    senderSide: varchar('sender_side', { length: 1 }).notNull(),
    /** Sender-generated idempotency key; null for system/bot messages. */
    clientRef: varchar('client_ref', { length: 64 }),
    type: chatMessageTypeEnum('type').notNull(),
    text: text('text'),
    product: jsonb('product').$type<ChatProductSnapshotValue>(),
    order: jsonb('order').$type<ChatOrderSnapshotValue>(),
    adjustment: jsonb('adjustment').$type<ChatAdjustmentSnapshotValue>(),
    offer: jsonb('offer').$type<ChatOfferSnapshotValue>(),
    attachment: jsonb('attachment').$type<ChatAttachmentValue>(),
    status: chatMessageStatusEnum('status').notNull().default('sent'),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    readAt: timestamp('read_at', { withTimezone: true }),
  },
  (table) => [
    index('chat_messages_conversation_sent_idx').on(
      table.conversationId,
      table.sentAt,
    ),
    index('chat_messages_sender_sent_idx').on(table.senderId, table.sentAt),
    uniqueIndex('chat_messages_sender_client_ref_idx').on(
      table.senderId,
      table.clientRef,
    ),
    check(
      'chat_messages_sender_side_check',
      sql`${table.senderSide} in ('a', 'b')`,
    ),
  ],
);

export const chatOfferStatusEnum = pgEnum('chat_offer_status', [
  'pending',
  'accepted',
  'rejected',
  'withdrawn',
  'expired',
]);

/** One line of an offer, priced by the seller when they composed it. */
export interface ChatOfferItemValue {
  productId: string;
  /** Copied in, so the card still reads correctly if the product is renamed. */
  name: string;
  qty: number;
  unitPriceCents: number;
  /** Cover snapshot, for the thumbnails on the card and View screen. Optional
      because offers written before thumbnails existed have none. */
  imageUrl?: string;
  emoji?: string;
  tone?: string;
  unit?: string;
  /** Storefront slug, so the card can link through to the product page. */
  slug?: string;
  /** The item's video, shown on the card when it has no photo. */
  videoUrl?: string;
  /** The item's zone delivery charges as they stood when the offer was made.
      Delivery is quoted from these once the buyer confirms their district, so
      a later edit to the product can't change the price of a live offer.
      Absent on offers from when the seller set one flat charge instead. */
  deliveryDhakaCents?: number;
  deliveryOutsideCents?: number;
}

/**
 * A seller's order proposal, sent into a chat thread. Accepting it places a
 * real order at these prices.
 *
 * This is a table rather than only a card payload because it gates money: it
 * is the single authority for what was offered and whether it has been used.
 * Acceptance flips `status` under a row lock, so a buyer double-tapping
 * "Accept" - or accepting on two devices - can only ever create one order.
 * The message card carries a summary copy for rendering (see
 * {@link ChatOfferSnapshotValue}); this row is what the accept path trusts.
 *
 * Prices are the seller's, not the catalog's - that is the point of an offer
 * - but stock is still checked and decremented at acceptance, so an offer can
 * never oversell.
 */
export const chatOrderOffers = pgTable(
  'chat_order_offers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => chatConversations.id, { onDelete: 'cascade' }),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    buyerId: uuid('buyer_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    items: jsonb('items').$type<ChatOfferItemValue[]>().notNull(),
    itemsSubtotalCents: integer('items_subtotal_cents').notNull(),
    /** Delivery charged on this offer. 0 until the buyer confirms where it is
        going - the charge comes from the items' zone rates and their district,
        the same rule checkout applies - then written here with the total. */
    deliveryCents: integer('delivery_cents').notNull().default(0),
    /** Items only until accepted; delivery is added once the district is known. */
    totalCents: integer('total_cents').notNull(),
    /** Optional seller note shown on the offer screen. */
    note: varchar('note', { length: 300 }),

    status: chatOfferStatusEnum('status').notNull().default('pending'),
    /** Set once accepted - the order this offer became. */
    orderId: uuid('order_id'),
    /** Optional deadline; past it the offer can no longer be accepted. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    respondedAt: timestamp('responded_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index('chat_order_offers_conversation_idx').on(table.conversationId),
    index('chat_order_offers_shop_idx').on(table.shopId),
  ],
);

/** Seller canned responses, shown as chips above the composer. */
export const chatQuickReplies = pgTable(
  'chat_quick_replies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    text: varchar('text', { length: 500 }).notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    /** Platform-seeded starter replies; sellers can remove but not edit them. */
    isDefault: boolean('is_default').notNull().default(false),
    /** Removed defaults are hidden, not deleted - the surviving rows mark the
        shop as already seeded so `list()` never re-inserts the starter set. */
    hidden: boolean('hidden').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index('chat_quick_replies_shop_idx').on(table.shopId)],
);

export const chatConversationsRelations = relations(
  chatConversations,
  ({ one, many }) => ({
    buyer: one(users, {
      fields: [chatConversations.buyerId],
      references: [users.id],
    }),
    shop: one(shops, {
      fields: [chatConversations.shopId],
      references: [shops.id],
    }),
    messages: many(chatMessages),
    participants: many(chatParticipants),
  }),
);

export const chatParticipantsRelations = relations(
  chatParticipants,
  ({ one }) => ({
    conversation: one(chatConversations, {
      fields: [chatParticipants.conversationId],
      references: [chatConversations.id],
    }),
    account: one(users, {
      fields: [chatParticipants.accountId],
      references: [users.id],
    }),
    shop: one(shops, {
      fields: [chatParticipants.shopId],
      references: [shops.id],
    }),
  }),
);

export const chatMessagesRelations = relations(chatMessages, ({ one }) => ({
  conversation: one(chatConversations, {
    fields: [chatMessages.conversationId],
    references: [chatConversations.id],
  }),
}));

export type ChatOriginType = (typeof chatOriginTypeEnum.enumValues)[number];
export type ChatSenderRole = (typeof chatSenderRoleEnum.enumValues)[number];
export type ChatMessageType = (typeof chatMessageTypeEnum.enumValues)[number];
export type ChatMessageStatus =
  (typeof chatMessageStatusEnum.enumValues)[number];

export type ChatPartyKind = (typeof chatPartyKindEnum.enumValues)[number];
export type ChatConversationRow = typeof chatConversations.$inferSelect;
export type NewChatConversationRow = typeof chatConversations.$inferInsert;
export type ChatParticipantRow = typeof chatParticipants.$inferSelect;
export type NewChatParticipantRow = typeof chatParticipants.$inferInsert;
export type ChatMessageRow = typeof chatMessages.$inferSelect;
export type NewChatMessageRow = typeof chatMessages.$inferInsert;
export type ChatQuickReplyRow = typeof chatQuickReplies.$inferSelect;
export type NewChatQuickReplyRow = typeof chatQuickReplies.$inferInsert;
export type ChatOfferStatus = (typeof chatOfferStatusEnum.enumValues)[number];
export type ChatOrderOfferRow = typeof chatOrderOffers.$inferSelect;
export type NewChatOrderOfferRow = typeof chatOrderOffers.$inferInsert;

export const chatOrderOffersRelations = relations(
  chatOrderOffers,
  ({ one }) => ({
    conversation: one(chatConversations, {
      fields: [chatOrderOffers.conversationId],
      references: [chatConversations.id],
    }),
    shop: one(shops, {
      fields: [chatOrderOffers.shopId],
      references: [shops.id],
    }),
  }),
);
