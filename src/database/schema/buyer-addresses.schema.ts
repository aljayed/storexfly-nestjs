import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { users, type BuyerGeoValue } from './users.schema';

/** Delivery recipients are independent of the account's verified identity. */
export const buyerAddresses = pgTable(
  'buyer_addresses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    label: varchar('label', { length: 40 }).notNull().default(''),
    name: varchar('name', { length: 160 }).notNull(),
    phone: varchar('phone', { length: 24 }).notNull(),
    address: text('address').notNull(),
    city: varchar('city', { length: 120 }).notNull(),
    pincode: varchar('pincode', { length: 24 }).notNull().default(''),
    geo: jsonb('geo').$type<BuyerGeoValue>(),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index('buyer_addresses_user_idx').on(table.userId),
    uniqueIndex('buyer_addresses_one_default_idx')
      .on(table.userId)
      .where(sql`${table.isDefault} = true`),
  ],
);
