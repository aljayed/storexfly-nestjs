import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { OrdersService } from './orders.service';
import {
  summarizeSellerOrders,
  type SellerAttentionRow,
} from './seller-order-attention';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const NOW = new Date('2026-09-14T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const row = (over: Partial<SellerAttentionRow> = {}): SellerAttentionRow => ({
  id: 'order-one',
  reference: '#1042',
  shopId: 'shop-one',
  shopName: 'First shop',
  status: 'New',
  pay: 'Due',
  placedAt: ago(HOUR),
  confirmedAt: null,
  handedOverAt: null,
  ...over,
});

describe('seller order attention', () => {
  it('counts new orders across shops and beyond one page of orders', () => {
    const rows = Array.from({ length: 65 }, (_, i) =>
      row({ id: `order-${i}` }),
    );
    rows.push(
      row({
        id: 'other',
        shopId: 'shop-two',
        shopName: 'Second shop',
        pay: 'Paid',
      }),
    );
    const result = summarizeSellerOrders(rows, NOW);
    expect(result.newOrders).toBe(66);
    expect(result.shops.map((s) => s.newOrders)).toEqual([65, 1]);
    expect(result.dueSoon).toBe(0);
    expect(result.urgentOrders).toEqual([]);
  });

  it('includes exactly 24 hours remaining but excludes anything later', () => {
    const result = summarizeSellerOrders(
      [
        row({ id: 'boundary', placedAt: ago(48 * HOUR) }),
        row({ id: 'later', placedAt: ago(48 * HOUR - 1) }),
      ],
      NOW,
    );
    expect(result.newOrders).toBe(2);
    expect(result.dueSoon).toBe(1);
    expect(result.urgentOrders.map((o) => o.id)).toEqual(['boundary']);
  });

  it('separates overdue orders from the next 24 hours, earliest first', () => {
    const result = summarizeSellerOrders(
      [
        row({ id: 'soon', placedAt: ago(60 * HOUR) }),
        row({ id: 'now', placedAt: ago(72 * HOUR) }),
        row({ id: 'past', placedAt: ago(73 * HOUR) }),
      ],
      NOW,
    );
    expect(result.dueSoon).toBe(1);
    expect(result.overdue).toBe(2);
    expect(result.urgentOrders.map((o) => o.id)).toEqual([
      'past',
      'now',
      'soon',
    ]);
  });

  it('uses confirmation, dispatch and delivery clocks without counting overlaps twice', () => {
    const result = summarizeSellerOrders(
      [
        row({ id: 'confirm', placedAt: ago(60 * HOUR) }),
        row({
          id: 'dispatch',
          status: 'Packed',
          placedAt: ago(10 * DAY),
          confirmedAt: ago(6 * DAY + 20 * HOUR),
        }),
        row({
          id: 'deliver',
          status: 'Confirmed',
          placedAt: ago(29 * DAY + 22 * HOUR),
          confirmedAt: ago(DAY),
        }),
      ],
      NOW,
    );
    expect(result.dueSoon).toBe(3);
    expect(result.urgentOrders.map((o) => [o.id, o.kind])).toEqual([
      ['deliver', 'deliver'],
      ['dispatch', 'dispatch'],
      ['confirm', 'confirm'],
    ]);
  });

  it('does not invent dispatch deadlines for legacy or already handed-over orders', () => {
    const result = summarizeSellerOrders(
      [
        row({
          id: 'legacy',
          status: 'Confirmed',
          placedAt: ago(10 * DAY),
          confirmedAt: null,
        }),
        row({
          id: 'handed',
          status: 'Packed',
          placedAt: ago(10 * DAY),
          confirmedAt: ago(8 * DAY),
          handedOverAt: ago(DAY),
        }),
        row({
          id: 'shipping',
          status: 'Shipped',
          placedAt: ago(29 * DAY + 23 * HOUR),
          handedOverAt: ago(DAY),
        }),
      ],
      NOW,
    );
    expect(result.overdue).toBe(0);
    expect(result.urgentOrders.map((o) => [o.id, o.kind])).toEqual([
      ['shipping', 'deliver'],
    ]);
  });

  it('excludes terminal orders and unfinished gateway payments', () => {
    const result = summarizeSellerOrders(
      [
        ...(['Delivered', 'Cancelled', 'Exchanged'] as const).map((status) =>
          row({ status, placedAt: ago(60 * DAY) }),
        ),
        row({ pay: 'Pending', placedAt: ago(5 * DAY) }),
      ],
      NOW,
    );
    expect(result).toMatchObject({
      newOrders: 0,
      dueSoon: 0,
      overdue: 0,
      shops: [],
      urgentOrders: [],
    });
  });

  it('keeps all urgent references, including identical references in different shops', () => {
    const rows = Array.from({ length: 32 }, (_, i) =>
      row({ id: `order-${i}`, placedAt: ago(60 * HOUR) }),
    );
    rows.push(row({ shopId: 'shop-two', placedAt: ago(60 * HOUR) }));
    expect(summarizeSellerOrders(rows, NOW).urgentOrders).toHaveLength(33);
  });

  it('scopes the database query to the authenticated owner and skips pending/finished orders', async () => {
    let predicate: SQL | undefined;
    let projection: Record<string, unknown> = {};
    const db = {
      select: (fields: Record<string, unknown>) => {
        projection = fields;
        return {
          from: () => ({
            innerJoin: () => ({
              where: (condition: SQL) => {
                predicate = condition;
                return Promise.resolve([]);
              },
            }),
          }),
        };
      },
    };
    await OrdersService.prototype.sellerAttention.call(
      { db } as unknown as OrdersService,
      'authenticated-owner',
    );
    const compiled = new PgDialect().sqlToQuery(predicate!);
    expect(compiled.sql).toContain('"shops"."owner_id" =');
    expect(compiled.params).toContain('authenticated-owner');
    expect(compiled.params).toEqual(
      expect.arrayContaining([
        'Pending',
        'Delivered',
        'Cancelled',
        'Exchanged',
      ]),
    );
    expect(projection).not.toHaveProperty('email');
    expect(projection).not.toHaveProperty('phone');
    expect(projection).not.toHaveProperty('customerName');
  });
});
