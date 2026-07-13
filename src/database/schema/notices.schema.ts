import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { noticeToneEnum } from './enums';
import { shops } from './shops.schema';

/**
 * Announcements the platform operator publishes to seller consoles. A notice
 * with a `shopId` targets that one shop; `shopId = null` broadcasts to every
 * shop. Sellers see active notices as banners at the top of their admin
 * panel; deactivating (or deleting) a notice removes it everywhere at once.
 */
export const notices = pgTable(
  'notices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id').references(() => shops.id, {
      onDelete: 'cascade',
    }),
    message: varchar('message', { length: 300 }).notNull(),
    tone: noticeToneEnum('tone').notNull().default('info'),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index('notices_shop_idx').on(table.shopId)],
);

export const noticesRelations = relations(notices, ({ one }) => ({
  shop: one(shops, {
    fields: [notices.shopId],
    references: [shops.id],
  }),
}));

export type NoticeRow = typeof notices.$inferSelect;
export type NewNoticeRow = typeof notices.$inferInsert;
