import { PgDialect } from 'drizzle-orm/pg-core';
import { CommerceService } from './commerce.service';

// Exercise the actual query construction and response mapping without a live DB.
function harness(results: unknown[][]) {
  const calls: { fields: Record<string, unknown>; where?: unknown }[] = [];
  const db = {
    select(fields: Record<string, unknown>) {
      const index = calls.length;
      const call = { fields, where: undefined as unknown };
      calls.push(call);
      const query = {
        from: () => query, innerJoin: () => query,
        where: (condition: unknown) => { call.where = condition; return query; },
        orderBy: () => query, groupBy: () => query, limit: () => query, offset: () => query,
        then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(results[index] ?? []).then(resolve),
      };
      return query;
    },
  };
  const service = Object.create(CommerceService.prototype) as CommerceService;
  Object.assign(service, { db });
  return { service, calls, db };
}
const dialect = new PgDialect();
const sqlText = (value: unknown) => dialect.sqlToQuery(value as Parameters<PgDialect['sqlToQuery']>[0]);

describe('Trade console summaries', () => {
  it('separates active, won and expired accepted quotes and converts pipeline cents once', async () => {
    const { service, calls } = harness([
      [], [], [], [],
      [
        { status: 'requested', n: 2, expired: 0, used: 0, valueCents: 0 },
        { status: 'quoted', n: 3, expired: 1, used: 0, valueCents: 30000 },
        { status: 'accepted', n: 5, expired: 2, used: 1, valueCents: 40000 },
        { status: 'declined', n: 1, expired: 0, used: 0, valueCents: 0 },
      ], [], [], [], [], [],
    ]);
    const result = await service.summary('shop-1');
    expect(result.supplier.quotes).toEqual({ requested: 2, quoted: 2, accepted: 2, won: 1, lost: 4, pipelineValue: 700 });
    const valueQuery = sqlText(calls[4].fields.valueCents).sql;
    // A used or expired offer must not inflate the open pipeline's money.
    expect(valueQuery).toContain('filter (where');
    expect(valueQuery).toContain('"used_at" is null');
    expect(valueQuery).toContain('"expires_at" > now()');
    const unitsQuery = sqlText(calls[2].fields.units).sql;
    expect(unitsQuery).toContain('oi.product_id is not null');
    expect(result.reseller.series).toHaveLength(14);
    expect(result.reseller.series.every(point => point.value === 0)).toBe(true);
  });

  it('hides unfinished payments and excludes shipping and discount rows from reseller item previews', async () => {
    const { service, calls } = harness([
      [{ order: { id: 'order-1', reference: 'R-1', totalCents: 10000, resellerMarginCents: 2000, address: { area: 'Dhaka' } }, supplierName: 'Supplier', supplierHandle: 'supplier' }],
      [{ orderId: 'order-1', name: 'Shirt', qty: 2, variant: null }],
    ]);
    const orders = await service.resellerOrders('reseller-1');
    expect(sqlText(calls[0].where).params).toContain('Pending');
    expect(sqlText(calls[0].where).sql).toContain('"pay" <>');
    expect(sqlText(calls[1].where).sql).toContain('"product_id" is not null');
    expect(orders[0]).toMatchObject({ total: 100, margin: 20, supplierName: 'Supplier', items: [{ name: 'Shirt', qty: 2 }] });
  });
  it('marks an out-of-stock supplier product unavailable until restocked', async () => {
    const product = { id: 'product-1', name: 'Shirt', stock: 0, listingType: 'sale', commerce: { channels: ['reseller'], resellerPriceCents: 30000 } };
    const { service, db } = harness([[{
      listing: { id: 'listing-1', active: true, sellingPriceCents: 45000 },
      product,
      supplier: { live: true, name: 'Supplier', handle: 'supplier', paymentMethods: ['card'], kycStatus: 'verified' },
    }]]);
    Object.assign(db, { query: {
      shops: { findFirst: async () => ({ handle: 'reseller' }) },
      paymentMethods: { findMany: async () => [{ kind: 'card' }] },
    } });
    expect((await service.listings('reseller-1'))[0]).toMatchObject({ active: true, available: false, stock: 0 });
    // A fresh read sees a restock; the reseller does not need to import again.
    product.stock = 3;
    const restocked = harness([[{ listing: { id: 'listing-1', active: true, sellingPriceCents: 45000 }, product, supplier: { live: true, paymentMethods: ['card'] } }]]);
    Object.assign(restocked.db, { query: {
      shops: { findFirst: async () => ({ handle: 'reseller' }) },
      paymentMethods: { findMany: async () => [{ kind: 'card' }] },
    } });
    expect((await restocked.service.listings('reseller-1'))[0].available).toBe(true);
  });

  it('reprices many listings, skipping duplicates and reporting refusals without stopping', async () => {
    const service = Object.create(CommerceService.prototype) as CommerceService;
    const calls: string[] = [];
    Object.assign(service, {
      updateListing: async (_shop: string, id: string, dto: { sellingPrice: number }) => {
        calls.push(`${id}:${dto.sellingPrice}`);
        if (id === 'bad') throw new Error('Your selling price must cover the supplier price.');
        return { ok: true };
      },
    });
    const result = await service.repriceListings('reseller-1', [
      { id: 'a', sellingPrice: 120 },
      { id: 'bad', sellingPrice: 10 },
      { id: 'a', sellingPrice: 999 },
      { id: 'b', sellingPrice: 199 },
    ]);
    expect(calls).toEqual(['a:120', 'bad:10', 'b:199']);
    expect(result).toEqual({ updated: 2, failed: [{ id: 'bad', ok: false, error: 'Your selling price must cover the supplier price.' }] });
  });
  it('sources only products a reseller could actually add, with profit and listed flags', async () => {
    const { service, calls, db } = harness([
      [
        { id: 'own', ownerId: 'me', paymentMethods: ['card'] },
        { id: 'sibling', ownerId: 'me', paymentMethods: ['card'] },
        { id: 'cod-only', ownerId: 'x', paymentMethods: ['cod'] },
        { id: 'supplier', ownerId: 'y', paymentMethods: ['card', 'cod'] },
      ],
      [{ id: 'p1', name: 'Shirt', slug: 'shirt', cat: 'Fashion', unit: 'piece', stock: 9, emoji: '', tone: '', rating: 4.5, reviews: 3, image: null, priceCents: 50000, supplyCents: 30000, supplierName: 'S', supplierHandle: 's', supplierKyc: 'verified' }],
      [{ n: 1 }],
      [{ name: 'Fashion', n: 1 }],
      [{ productId: 'p1' }],
    ]);
    Object.assign(db, { query: {
      shops: { findFirst: async () => ({ id: 'own', ownerId: 'me', currency: 'BDT' }) },
      paymentMethods: { findMany: async () => [{ kind: 'card' }] },
    } });
    const result = await service.sourcing('own', { sort: 'profit' });
    // Own shop, a sibling shop of the same owner and a COD-only supplier are out.
    expect(sqlText(calls[1].where).params).toEqual(expect.arrayContaining(['supplier']));
    for (const excluded of ['own', 'sibling', 'cod-only']) expect(sqlText(calls[1].where).params).not.toContain(excluded);
    expect(sqlText(calls[1].where).sql).toContain('"stock" > ');
    expect(result.items[0]).toMatchObject({ supplyPrice: 300, retailPrice: 500, profitAtRetail: 200, listed: true, supplierVerified: true });
    expect(result).toMatchObject({ total: 1, hasMore: false, categories: [{ name: 'Fashion', n: 1 }] });
  });
  it('returns an empty sourcing page without querying products when no supplier qualifies', async () => {
    const { service, calls, db } = harness([[{ id: 'own', ownerId: 'me', paymentMethods: ['card'] }]]);
    Object.assign(db, { query: {
      shops: { findFirst: async () => ({ id: 'own', ownerId: 'me', currency: 'BDT' }) },
      paymentMethods: { findMany: async () => [{ kind: 'card' }] },
    } });
    expect(await service.sourcing('own', {})).toEqual({ items: [], total: 0, page: 1, hasMore: false, categories: [] });
    expect(calls).toHaveLength(1);
  });
  it('narrows sourcing to one supplier when their handle is given', async () => {
    const { service, calls, db } = harness([
      [
        { id: 'a', ownerId: 'x', paymentMethods: ['card'], handle: 'alpha' },
        { id: 'b', ownerId: 'y', paymentMethods: ['card'], handle: 'beta' },
      ],
      [], [{ n: 0 }], [], [],
    ]);
    Object.assign(db, { query: {
      shops: { findFirst: async () => ({ id: 'own', ownerId: 'me', currency: 'BDT' }) },
      paymentMethods: { findMany: async () => [{ kind: 'card' }] },
    } });
    await service.sourcing('own', { supplier: 'beta' });
    expect(sqlText(calls[1].where).params).toContain('b');
    expect(sqlText(calls[1].where).params).not.toContain('a');
    // An unknown handle is an empty shelf, not everyone's products.
    const none = harness([[{ id: 'a', ownerId: 'x', paymentMethods: ['card'], handle: 'alpha' }]]);
    Object.assign(none.db, { query: (db as unknown as { query: unknown }).query });
    expect((await none.service.sourcing('own', { supplier: 'nobody' })).items).toEqual([]);
    expect(none.calls).toHaveLength(1);
  });
  it('lists suppliers a reseller can source from, with catalogue numbers and what is already listed', async () => {
    const shop = (id: string, extra: Record<string, unknown> = {}) => ({
      id, ownerId: `owner-${id}`, paymentMethods: ['card'], name: id.toUpperCase(), handle: id, tagline: null,
      brand: '#123456', city: 'Dhaka', kycStatus: 'unsubmitted', createdAt: new Date('2026-01-01'), ...extra,
    });
    const run = async (query: Parameters<CommerceService['suppliers']>[1]) => {
      const { service, calls, db } = harness([
        [
          shop('own', { ownerId: 'me' }),
          shop('cod-only', { paymentMethods: ['cod'] }),
          shop('small', { createdAt: new Date('2026-03-01') }),
          shop('big', { kycStatus: 'verified', tagline: 'Feed and farm supply' }),
          shop('empty'),
        ],
        [
          { shopId: 'small', products: 2, fromCents: 9000, bestProfitCents: 6000, avgMarginPct: 40, categories: ['Fashion'], previews: [] },
          { shopId: 'big', products: 12, fromCents: 50000, bestProfitCents: 30000, avgMarginPct: 22, categories: ['Feed', 'Cattle feed'], previews: [{ image: 'a.jpg', emoji: null, tone: null }] },
        ],
        [{ shopId: 'big', n: 3 }],
      ]);
      Object.assign(db, { query: {
        shops: { findFirst: async () => ({ id: 'own', ownerId: 'me', currency: 'BDT' }) },
        paymentMethods: { findMany: async () => [{ kind: 'card' }] },
      } });
      return { result: await service.suppliers('own', query), calls };
    };
    const { result, calls } = await run({});
    // Own and COD-only shops never reach the product query; a shop with
    // nothing resellable has no row and so no card.
    for (const excluded of ['own', 'cod-only']) expect(sqlText(calls[1].where).params).not.toContain(excluded);
    expect(result.total).toBe(2);
    expect(result.suppliers.map((s) => s.handle)).toEqual(['big', 'small']);
    expect(result.suppliers[0]).toMatchObject({
      name: 'BIG', verified: true, products: 12, fromPrice: 500, bestProfit: 300, avgMarginPct: 22,
      categories: ['Cattle feed', 'Feed'], previews: [{ image: 'a.jpg', emoji: null, tone: null }], listed: 3, city: 'Dhaka',
    });
    expect(result.suppliers[1]).toMatchObject({ previews: [], listed: 0 });
    expect((await run({ sort: 'margin' })).result.suppliers.map((s) => s.handle)).toEqual(['small', 'big']);
    expect((await run({ sort: 'new' })).result.suppliers.map((s) => s.handle)).toEqual(['small', 'big']);
    expect((await run({ q: 'cattle' })).result.suppliers.map((s) => s.handle)).toEqual(['big']);
    expect((await run({ q: 'farm' })).result.suppliers.map((s) => s.handle)).toEqual(['big']);
    expect((await run({ q: 'zzz' })).result).toEqual({ suppliers: [], total: 0 });
  });
});
