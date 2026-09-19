import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { drizzle } from 'drizzle-orm/pg-proxy';
import * as schema from '../../database/schema';
import type { DrizzleDB } from '../../database/drizzle.types';
import { DiscoverQuery } from './dto/discover.query';
import { ShopsService } from './shops.service';

function harness(productRows: unknown[][] = [], total = 0) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const db = drizzle(async (sql, params) => {
    queries.push({ sql, params });
    if (sql.includes('group by')) return { rows: [['Home', 29], ['Books', 3]] };
    if (sql.includes('count(*)')) return { rows: [[total]] };
    if (sql.includes('inner join')) return { rows: productRows };
    return { rows: [] };
  }, { schema });
  const service = new ShopsService(db as unknown as DrizzleDB, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
  return { service, queries };
}

describe('public marketplace discovery', () => {
  it('validates page bounds and rejects unsupported filters before querying', async () => {
    const valid = plainToInstance(DiscoverQuery, { page: '2', limit: '24', q: '  mug  ' });
    expect(await validate(valid)).toHaveLength(0);
    expect(valid).toMatchObject({ q: 'mug', page: 2, limit: 24 });
    for (const input of [{ page: '0' }, { page: '-1' }, { page: '1.5' }, { limit: '999' }, { sort: 'anything' }, { q: ['one', 'two'] }, { q: 'x'.repeat(101) }]) {
      expect((await validate(plainToInstance(DiscoverQuery, input))).length).toBeGreaterThan(0);
    }
  });

  it('applies the same live-shop search/category/stock conditions to results and totals', async () => {
    const h = harness([], 29);
    const result = await h.service.discover(Object.assign(new DiscoverQuery(), {
      q: '100%_cotton', category: 'Home', availability: 'stock', page: 2, limit: 12,
    }));
    const results = h.queries.find(q => q.sql.includes('inner join') && !q.sql.includes('count(*)'))!;
    const count = h.queries.find(q => q.sql.includes('count(*)') && !q.sql.includes('group by'))!;
    expect(results.sql).toContain('"shops"."live" =');
    expect(results.sql).toContain('"products"."stock" >');
    expect(results.sql).toContain('limit');
    expect(results.sql).toContain('offset');
    expect(results.sql).not.toContain('100%_cotton');
    expect(results.params).toContain('%100\\%\\_cotton%');
    expect(results.params).toContain('sale');
    expect(results.params).toContain('Home');
    expect(results.params.slice(-2)).toEqual([12, 12]);
    expect(count.params).toEqual(results.params.slice(0, -2));
    expect(result).toMatchObject({ total: 29, page: 2, limit: 12, hasMore: true });
    expect(result.categories).toEqual([{ name: 'Home', count: 29 }, { name: 'Books', count: 3 }]);
    const categories = h.queries.find(q => q.sql.includes('group by'))!;
    expect(categories.params).toEqual([true]);
  });

  it('uses stable sort order and allows contact-to-buy products without requiring stock', async () => {
    const h = harness();
    await h.service.discover(Object.assign(new DiscoverQuery(), { sort: 'rating', availability: 'showcase' }));
    const products = h.queries.find(q => q.sql.includes('inner join') && !q.sql.includes('count(*)'))!;
    expect(products.sql).toContain('order by "products"."rating" desc');
    expect(products.sql).toContain('"products"."id" desc');
    expect(products.params).toContain('showcase');
    expect(products.sql).not.toContain('"products"."stock" >');
  });

  it('returns lightweight public cards with real prices and correct final-page metadata', async () => {
    const row = ['id-1', 'Home', 'Ceramic mug', 'mug', 'sale', 65000, 80000, 'piece', 8, '☕', '#eee', null, 4.5, 2, '/api/media/mug.webp', 'studio', 'Studio', 'BDT'];
    const h = harness([row], 25);
    const result = await h.service.discover(Object.assign(new DiscoverQuery(), { page: 2 }));
    expect(result).toMatchObject({ total: 25, page: 2, hasMore: false });
    expect(result.products[0]).toMatchObject({ id: 'id-1', category: 'Home', price: 650, comparePrice: 800, image: '/api/media/mug.webp', shopHandle: 'studio' });
    expect(result.products[0]).not.toHaveProperty('images');
    const showcase = [...row]; showcase[4] = 'showcase';
    expect((await harness([showcase]).service.discover()).products[0].comparePrice).toBeUndefined();
  });
});
