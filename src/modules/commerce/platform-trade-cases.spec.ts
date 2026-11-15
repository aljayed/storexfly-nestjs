import { drizzle } from 'drizzle-orm/pg-proxy';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CommerceService } from './commerce.service';
import { PlatformDisputesQueryDto, ResolveDisputeDto } from './commerce.dto';
import type { DrizzleDB } from '../../database/drizzle.types';

// Compile and execute through Drizzle's local proxy, without a live database.
function harness() {
  const queries: { sql: string; params: unknown[] }[] = [];
  const db = drizzle(async (sql, params) => {
    queries.push({ sql, params });
    return { rows: [] };
  });
  return { service: new CommerceService(db as unknown as DrizzleDB), queries };
}

describe('Platform trade case queue', () => {
  it('keeps resolved records out of the default queue and supplies order context in its original currency', async () => {
    const { service, queries } = harness();
    await service.platformDisputes();
    expect(queries[0].sql).toContain('"trade_disputes"."status" <>');
    expect(queries[0].params).toContain('resolved');
    expect(queries[0].sql).toContain('"shops"."currency"');
    expect(queries[0].sql).toContain('"orders"."customer_name"');
    expect(queries[0].sql).toContain('"orders"."commerce_mode"');
  });

  it('reads only resolved cases for history, ordered by resolution date', async () => {
    const { service, queries } = harness();
    await service.platformDisputes('resolved');
    expect(queries[0].sql).toContain('"trade_disputes"."status" =');
    expect(queries[0].params).toContain('resolved');
    expect(queries[0].sql).toContain('order by "trade_disputes"."resolved_at" desc');
  });

  it('refuses to overwrite a missing or already resolved decision', async () => {
    const { service, queries } = harness();
    const id = '11111111-1111-4111-8111-111111111111';
    await expect(service.platformResolve(id, 'Refund already completed.')).rejects.toThrow('Open case not found');
    expect(queries).toHaveLength(1);
    const where = queries[0].sql.split(' where ')[1];
    expect(where).toContain('"trade_disputes"."id" =');
    expect(where).toContain('"trade_disputes"."status" <>');
    expect(queries[0].params).toContain(id);
    // Resolving records the decision; it does not call a refund or payout API.
    expect(queries[0].sql).toMatch(/^update "trade_disputes"/);
  });

  it('validates queue scope and trims decisions before enforcing the minimum length', async () => {
    expect(await validate(plainToInstance(PlatformDisputesQueryDto, {}))).toHaveLength(0);
    expect(await validate(plainToInstance(PlatformDisputesQueryDto, { status: 'resolved' }))).toHaveLength(0);
    expect(await validate(plainToInstance(PlatformDisputesQueryDto, { status: 'anything' }))).not.toHaveLength(0);
    expect(await validate(plainToInstance(ResolveDisputeDto, { resolution: '             ' }))).not.toHaveLength(0);
    const decision = plainToInstance(ResolveDisputeDto, { resolution: '  Refund completed and receipt checked.  ' });
    expect(await validate(decision)).toHaveLength(0);
    expect(decision.resolution).toBe('Refund completed and receipt checked.');
  });
});
