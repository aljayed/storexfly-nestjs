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
