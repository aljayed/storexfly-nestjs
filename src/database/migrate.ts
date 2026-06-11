import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import * as path from 'node:path';

/**
 * Standalone migration runner (used by `pnpm db:migrate`). Applies every
 * pending SQL migration in `src/database/migrations` then exits. Safe to run
 * repeatedly — Drizzle tracks applied migrations in `__drizzle_migrations`.
 */
async function runMigrations(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set');
  }

  const migrationClient = postgres(url, { max: 1 });
  try {
    const db = drizzle(migrationClient);
    const migrationsFolder = path.join(__dirname, 'migrations');
    // eslint-disable-next-line no-console
    console.log(`Applying migrations from ${migrationsFolder} ...`);
    await migrate(db, { migrationsFolder });
    // eslint-disable-next-line no-console
    console.log('Migrations applied successfully.');
  } finally {
    await migrationClient.end({ timeout: 5 });
  }
}

runMigrations().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Migration failed:', err);
  process.exit(1);
});
