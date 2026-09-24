import { PgDialect } from 'drizzle-orm/pg-core';
import { SettlementsService } from './settlements.service';
import { monthRange } from './settlement-core';

/**
 * How a cycle's window reaches the database.
 *
 * `settledOn` is an expression - a coalesce over two columns - and not a
 * column, so the driver has no column type to map a value onto when it binds
 * one against it. A JS Date handed straight to that comparison is rejected
 * before Postgres ever sees the statement, and the whole settlements screen
 * fails with it. Every boundary therefore goes down as text with a cast, and
 * this is the test that says so: nothing in the parameters may be a Date.
 */
describe('the cycle window, as the database receives it', () => {
  const compile = (from: Date, end: Date) =>
    new PgDialect().sqlToQuery(SettlementsService.settledWithin(from, end)!);

  it('binds the boundaries as text, never as dates', () => {
    const { params } = compile(...monthRange('2026-09'));

    expect(params).toHaveLength(2);
    for (const p of params) {
      expect(p).not.toBeInstanceOf(Date);
      expect(typeof p).toBe('string');
    }
  });

  it('sends each boundary as the instant it stands for', () => {
    const [from, end] = monthRange('2026-09');
    const { params } = compile(from, end);

    expect(params).toEqual([from.toISOString(), end.toISOString()]);
  });

  it('casts both sides so the comparison has a type', () => {
    const { sql } = compile(...monthRange('2026-09'));

    expect(sql).toContain('::timestamptz');
    // Half-open: the closing boundary belongs to the next cycle, not this one.
    expect(sql).toContain('>=');
    expect(sql).toContain('<');
    expect(sql).not.toContain('<=');
  });

  it('asks the delivery stamp first and the handover only for manual shops', () => {
    const { sql } = compile(...monthRange('2026-09'));

    expect(sql).toContain('coalesce');
    expect(sql).toContain('"delivered_at"');
    expect(sql).toContain('"handed_over_at"');
    expect(sql).toContain("'manual'");
  });
});
