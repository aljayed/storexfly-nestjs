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
});
