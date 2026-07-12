/**
 * Schema barrel — single source of truth for Drizzle. Imported by the database
 * provider (for the typed `db` client + relational queries) and by drizzle-kit
 * (for migration generation). Keep every table/enum/relation exported here.
 */
export * from './enums';
export * from './users.schema';
export * from './shops.schema';
export * from './admin-users.schema';
export * from './products.schema';
export * from './reviews.schema';
export * from './customers.schema';
export * from './orders.schema';
export * from './subscriptions.schema';
export * from './coupons.schema';
export * from './platform-settings.schema';
export * from './buyers.schema';
export * from './chat.schema';
export * from './blocked-words.schema';
