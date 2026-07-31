import { relations } from 'drizzle-orm';
import {
  boolean,
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
 * Hoomri Chat — customer ↔ seller messaging (see design_handoff_hoomri_chat).
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
  sentAt: string;
}

/**
 * Point-in-time copy of a product embedded in a product-card message — a
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

/**
 * A shop-initiated order-amount change embedded in an 'adjustment' card. A
 * `decrease` is auto-applied (status 'approved') and purely informational; an
 * `increase` starts 'pending' and the buyer approves/declines from the card.
 * Totals are decimal (major units). Kept as a snapshot like the other cards.
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
}

/**
 * Card summary of an order offer. Deliberately small — enough to render the
 * bubble with a total and a status; the View screen fetches the full offer,
 * which is the authoritative copy (see `chatOrderOffers`).
 */
export interface ChatOfferSnapshotValue {
  offerId: string;
  /** "2 × Alphonso Mango Box + 1 more" — precomputed for the bubble. */
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
  /** First line's slug and video — the card links to the product page, and
      falls back to the video's still when the item has no photo. */
  slug?: string;
  videoUrl?: string;
  /** Delivery in the offer's currency — 0 means the seller made it free. */
  delivery?: number;
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
    buyerId: uuid('buyer_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    // What started (or most recently re-entered) the thread — drives the
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
    uniqueIndex('chat_conversations_buyer_shop_unique_idx').on(
      table.buyerId,
      table.shopId,
    ),
    index('chat_conversations_shop_idx').on(table.shopId),
    index('chat_conversations_buyer_idx').on(table.buyerId),
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
    // the shop replies on its behalf).
    senderId: uuid('sender_id').notNull(),
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
}

/**
 * A seller's order proposal, sent into a chat thread. Accepting it places a
 * real order at these prices.
 *
 * This is a table rather than only a card payload because it gates money: it
 * is the single authority for what was offered and whether it has been used.
 * Acceptance flips `status` under a row lock, so a buyer double-tapping
 * "Accept" — or accepting on two devices — can only ever create one order.
 * The message card carries a summary copy for rendering (see
 * {@link ChatOfferSnapshotValue}); this row is what the accept path trusts.
 *
 * Prices are the seller's, not the catalog's — that is the point of an offer
 * — but stock is still checked and decremented at acceptance, so an offer can
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
    /** Seller-set delivery charge for this offer (0 = free). */
    deliveryCents: integer('delivery_cents').notNull().default(0),
    totalCents: integer('total_cents').notNull(),
    /** Optional seller note shown on the offer screen. */
    note: varchar('note', { length: 300 }),

    status: chatOfferStatusEnum('status').notNull().default('pending'),
    /** Set once accepted — the order this offer became. */
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
    /** Removed defaults are hidden, not deleted — the surviving rows mark the
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

export type ChatConversationRow = typeof chatConversations.$inferSelect;
export type NewChatConversationRow = typeof chatConversations.$inferInsert;
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
