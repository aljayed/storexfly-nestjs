import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ShopsService } from './shops.service';

/**
 * "One trade licence, one shop" is enforced twice: a lookup in ShopsService,
 * which produces the sentence the seller reads, and a partial unique index,
 * which is what actually holds under a race. Both compare a *normalised*
 * licence number, and they have to normalise it identically - if they drift,
 * the pre-check waves a duplicate through and the seller gets a raw 500, or
 * worse, two shops end up sharing a licence because neither side agreed it
 * was the same string.
 *
 * So this pins the normalisation, and then pins that the SQL expression in
 * the migration still spells out the same rule.
 */
describe('trade-licence normalisation', () => {
  // Private on purpose - nothing outside the service should be minting these.
  const key = (v: string): string =>
    (
      ShopsService as unknown as { licenseKey: (v: string) => string }
    ).licenseKey(v);

  const LICENCE = 'TRAD/DNCC/004912/2026';

  it('treats one licence written several ways as the same licence', () => {
    const canonical = key(LICENCE);
    expect(key('trad/dncc/004912/2026')).toBe(canonical);
    expect(key('TRAD / DNCC / 004912 / 2026')).toBe(canonical);
    expect(key('  TRAD/DNCC/004912/2026  ')).toBe(canonical);
    expect(key('Trad/Dncc/004912/2026')).toBe(canonical);
    // Tabs and newlines are whitespace too - a pasted number can carry them.
    expect(key('TRAD/DNCC/\t004912/2026\n')).toBe(canonical);
  });

  it('keeps genuinely different licences apart', () => {
    expect(key('TRAD/DNCC/004913/2026')).not.toBe(key(LICENCE));
    expect(key('TRAD/DSCC/004912/2026')).not.toBe(key(LICENCE));
    // Separators are part of the number, not noise - stripping them would
    // merge licences that two different authorities really did issue.
    expect(key('TRAD-DNCC-004912-2026')).not.toBe(key(LICENCE));
  });

  it('yields nothing for a number that is only whitespace', () => {
    expect(key('   ')).toBe('');
  });

  it('still matches the SQL the unique index is built from', () => {
    const sql = readFileSync(
      join(__dirname, '../../database/migrations/0088_shop_license_unique.sql'),
      'utf8',
    );
    // The index normalises with upper(regexp_replace(..., '\s', '', 'g')) -
    // the same two operations, in the same order, as licenseKey above.
    expect(sql).toContain(
      `upper(regexp_replace("kyc_license_no", '\\s', '', 'g'))`,
    );
    // Partial, so shops that submitted no licence never collide with one
    // another - most rows are null.
    expect(sql).toContain(`WHERE "kyc_license_no" IS NOT NULL`);
  });
});
