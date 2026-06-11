import {
  Global,
  Logger,
  Module,
  OnModuleDestroy,
  type Provider,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { DRIZZLE } from './database.constants';
import type { DrizzleDB } from './drizzle.types';
import * as schema from './schema';

/**
 * Holds the raw postgres-js connection alongside the Drizzle client so the
 * module can close the pool cleanly on shutdown.
 */
const POSTGRES_CLIENT = Symbol('POSTGRES_CLIENT');

const postgresProvider: Provider = {
  provide: POSTGRES_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService) => {
    const url = config.getOrThrow<string>('database.url');
    return postgres(url, {
      max: 10,
      idle_timeout: 20,
      connect_timeout: 10,
    });
  },
};

const drizzleProvider: Provider = {
  provide: DRIZZLE,
  inject: [POSTGRES_CLIENT],
  useFactory: (client: postgres.Sql): DrizzleDB =>
    drizzle(client, { schema, logger: false }),
};

/**
 * Global database module. Exposes the Drizzle client under the {@link DRIZZLE}
 * token; inject it anywhere with `@Inject(DRIZZLE) db: DrizzleDB`.
 */
@Global()
@Module({
  providers: [postgresProvider, drizzleProvider],
  exports: [DRIZZLE],
})
export class DatabaseModule implements OnModuleDestroy {
  private readonly logger = new Logger(DatabaseModule.name);

  constructor(private readonly moduleRef: ModuleRef) {}

  async onModuleDestroy(): Promise<void> {
    const client = this.moduleRef.get<postgres.Sql>(POSTGRES_CLIENT, {
      strict: false,
    });
    if (client) {
      await client.end({ timeout: 5 });
      this.logger.log('PostgreSQL connection pool closed');
    }
  }
}
