import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { products } from './products.schema';
import { buyers } from './buyers.schema';

/**
 * A buyer review shown on the product page (`.pp-reviews`). Drives the score,
 * rating-distribution bars, and review cards. When written by a signed-in buyer
 * who bought the product, `buyerId` is set and `verified` is true; `imageUrl`
 * is an optional photo (stored inline as a data URL, like product images).
 */
export const reviews = pgTable(
  'reviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    buyerId: uuid('buyer_id').references(() => buyers.id, {
      onDelete: 'set null',
    }),
    author: varchar('author', { length: 160 }).notNull(),
    rating: integer('rating').notNull(),
    body: text('body').notNull().default(''),
    imageUrl: text('image_url'),
    verified: boolean('verified').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('reviews_product_idx').on(table.productId),
    index('reviews_buyer_idx').on(table.buyerId),
  ],
);

export const reviewsRelations = relations(reviews, ({ one }) => ({
  product: one(products, {
    fields: [reviews.productId],
    references: [products.id],
  }),
}));

export type ReviewRow = typeof reviews.$inferSelect;
export type NewReviewRow = typeof reviews.$inferInsert;
