import { PgDialect } from 'drizzle-orm/pg-core';
import { ordersOwnedBy } from './order-owner.util';

/**
 * "Which orders are mine" is now asked in six places - the profile's orders
 * and payments tabs, verified-purchase reviews, two chat lookups and order
 * claiming - and they all ask it through here. The rule has two halves and
 * both matter:
 *
 *   - orders the account placed are its own, keyed on the account, so
 *     changing email keeps every one of them;
 *   - a guest order is matched on the address it was placed with, but only
 *     while nothing else claims it.
 *
 * That second guard is the whole point. Without it, an order deliberately
 * linked to one account would start surfacing for whoever held that email
 * address next - which is the failure this change exists to remove, only
 * pointed the other way.
 */
describe('ordersOwnedBy', () => {
  /**
   * Render the clause the way the driver eventually will, so these assert on
   * the SQL that actually runs rather than on the builder's internals.
   */
  const dialect = new PgDialect();
  function render(accountId: string, email?: string | null) {
    const { sql, params } = dialect.sqlToQuery(ordersOwnedBy(accountId, email));
    return { sql: sql.toLowerCase(), params: params };
  }

  it('matches on the account, so a changed email keeps the history', () => {
    const { sql, params } = render('account-1', 'old@example.com');
    expect(sql).toContain('"user_id"');
    expect(params).toContain('account-1');
  });

  it('still finds guest orders placed with the address the account owns', () => {
    const { params } = render('account-1', 'Guest@Example.com');
    // Lower-cased, because that is how the column is compared.
    expect(params).toContain('guest@example.com');
  });

  // The guard that stops the rule leaking someone else's order.
  it('only claims an unowned guest order, never one already linked', () => {
    const { sql } = render('account-1', 'guest@example.com');
    expect(sql).toContain('"user_id" is null');
  });

  it('asks only about the account when it has no email at all', () => {
    const { sql, params } = render('account-1', null);
    expect(params).toContain('account-1');
    // Nothing to match an address against, so no email branch is built - and
    // in particular no `IS NULL` fallback that would sweep in every guest
    // order on the platform.
    expect(sql).not.toContain('is null');
  });

  it('treats a blank email as no email rather than matching empty strings', () => {
    const { sql } = render('account-1', '   ');
    expect(sql).not.toContain('is null');
  });
});
