import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from './schema';

/**
 * The fully-typed Drizzle client, with the relational schema baked in so that
 * `db.query.*` relational lookups are available and type-checked everywhere.
 */
export type DrizzleDB = PostgresJsDatabase<typeof schema>;

/**
 * The transaction-scoped executor passed to `db.transaction(async (tx) => …)`.
 * Has the same query surface as {@link DrizzleDB}, so services can accept
 * either and run inside or outside a transaction.
 */
export type DrizzleTx = Parameters<
  Parameters<DrizzleDB['transaction']>[0]
>[0];

/** Either the root client or a transaction — for composable data-access. */
export type DbExecutor = DrizzleDB | DrizzleTx;
