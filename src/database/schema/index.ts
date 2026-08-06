/**
 * Schema barrel - single source of truth for Drizzle. Imported by the database
 * provider (for the typed `db` client + relational queries) and by drizzle-kit
 * (for migration generation). Keep every table/enum/relation exported here.
 */
export * from './enums';
export * from './users.schema';
export * from './shops.schema';
export * from './admin-users.schema';
export * from './admin-invites.schema';
export * from './products.schema';
export * from './reviews.schema';
export * from './customers.schema';
export * from './orders.schema';
export * from './order-amount-adjustments.schema';
export * from './combos.schema';
export * from './shop-coupons.schema';
export * from './credit-packs.schema';
export * from './subscriptions.schema';
export * from './coupons.schema';
export * from './referral-links.schema';
export * from './platform-settings.schema';
export * from './chat.schema';
export * from './blocked-words.schema';
export * from './settlements.schema';
export * from './deleted-shop-settlements.schema';
export * from './notices.schema';
export * from './payment-methods.schema';
export * from './gateway-payments.schema';
export * from './shop-couriers.schema';
export * from './courier-webhook-events.schema';
export * from './buyer-notifications.schema';
