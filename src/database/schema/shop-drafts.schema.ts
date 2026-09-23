import { relations, sql } from 'drizzle-orm';
import {
  index,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { shops } from './shops.schema';
import { users } from './users.schema';

/**
 * A shop that has been filled in but not paid for yet.
 *
 * Opening a shop costs a credit pack, and the money is collected on a hosted
 * checkout the seller leaves the site for. That leaves a gap - minutes, or a
 * lunch break - between "I have chosen my name" and "I have paid for it", and
 * a name is the one thing in the wizard that two sellers can want at once.
 * So the whole submission waits here, and the row holds the handle while it
 * does: `shop_drafts_handle_pending_idx` is unique over pending rows, and the
 * availability check treats a live draft exactly like a shop.
 *
 * The hold is deliberately short. `expiresAt` is an hour out, and a draft
 * past it is not a reservation any more - the checks read the clock rather
 * than waiting for the sweep, so the name is free on the hour whether or not
 * anything has swept yet.
 *
 * Nothing here is a shop. The shop is written when the gateway says the money
 * landed (ShopOpeningService), and this row keeps `shopId` afterwards so a
 * payment can always be traced to what it opened.
 */
export const shopDrafts = pgTable(
  'shop_drafts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The name being held. Unique among pending drafts, and against shops. */
    handle: varchar('handle', { length: 80 }).notNull(),
    /** The shop's name, so the console and the gateway have something to say. */
    name: varchar('name', { length: 160 }).notNull(),
    /**
     * The wizard's submission, validated when it was made and replayed when
     * the payment lands. Stored whole rather than as columns: this is the
     * create-shop request in transit, and it should not have to be kept in
     * step with the DTO twice.
     */
    payload: jsonb('payload').notNull(),
    /** The pack the seller picked at checkout, once they have. */
    packCode: varchar('pack_code', { length: 32 }),
    couponCode: varchar('coupon_code', { length: 40 }),
    /**
     * pending - holding the handle, waiting for money.
     * paid    - the shop exists; `shopId` says which.
     * expired - the hour ran out; the handle is somebody else's to take.
     * cancelled - the seller went back and changed it.
     * failed  - the money landed but the shop could not be written. Rare, and
     *           deliberately loud: somebody has paid for something they have
     *           not got.
     */
    status: varchar('status', { length: 20 }).notNull().default('pending'),
    shopId: uuid('shop_id').references(() => shops.id, { onDelete: 'set null' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // The reservation itself: one live claim per handle, and the database is
    // what enforces it - two wizards submitting the same name in the same
    // second is exactly the case a check-then-insert would lose.
    uniqueIndex('shop_drafts_handle_pending_idx')
      .on(table.handle)
      .where(sql`${table.status} = 'pending'`),
    index('shop_drafts_owner_idx').on(table.ownerId, table.status),
    index('shop_drafts_expiry_idx').on(table.status, table.expiresAt),
  ],
);

export const shopDraftsRelations = relations(shopDrafts, ({ one }) => ({
  owner: one(users, {
    fields: [shopDrafts.ownerId],
    references: [users.id],
  }),
  shop: one(shops, {
    fields: [shopDrafts.shopId],
    references: [shops.id],
  }),
}));

export type ShopDraftRow = typeof shopDrafts.$inferSelect;
export type NewShopDraftRow = typeof shopDrafts.$inferInsert;
