import {
  DISPLAY_CURRENCIES,
  currencyForCountry,
  normalizeCountry,
} from '../../common/constants/display-currencies';
import { CurrencyController } from './currency.controller';
import { FxRatesService, cleanRates, looksWrong } from './fx-rates.service';

const fullRates = (
  over: Record<string, number> = {},
): Record<string, number> => ({
  ...Object.fromEntries(DISPLAY_CURRENCIES.map((c) => [c, 0.01])),
  BDT: 1,
  ...over,
});

describe('Display currency', () => {
  it('maps a country to the currency its buyers read', () => {
    expect(currencyForCountry('BD')).toBe('BDT');
    expect(currencyForCountry('US')).toBe('USD');
    expect(currencyForCountry('DE')).toBe('EUR');
    expect(currencyForCountry('IN')).toBe('INR');
    // A real country we do not list reads USD; no country at all reads BDT.
    expect(currencyForCountry('KE')).toBe('USD');
    expect(currencyForCountry(null)).toBe('BDT');
  });

  it("ignores edge codes that aren't countries", () => {
    expect(normalizeCountry('bd')).toBe('BD');
    expect(normalizeCountry('XX')).toBeNull();
    expect(normalizeCountry('T1')).toBeNull();
    expect(normalizeCountry(undefined)).toBeNull();
    expect(normalizeCountry('USA')).toBeNull();
  });

  it('rejects a rate table that is partial or has a bad number', () => {
    expect(cleanRates(fullRates())).not.toBeNull();
    const missing = fullRates();
    delete missing.USD;
    expect(cleanRates(missing)).toBeNull();
    expect(cleanRates(fullRates({ EUR: 0 }))).toBeNull();
    expect(cleanRates(fullRates({ EUR: Number.NaN }))).toBeNull();
    // Whatever the feed says about the base, one taka is one taka.
    expect(cleanRates(fullRates({ BDT: 5 }))!.BDT).toBe(1);
  });

  it('flags an implausible jump but not an ordinary move', () => {
    expect(looksWrong(fullRates(), fullRates({ USD: 0.0102 }))).toBe(false);
    expect(looksWrong(fullRates(), fullRates({ USD: 0.02 }))).toBe(true);
  });

  describe('GET /currency', () => {
    const controller = (snapshot: ReturnType<FxRatesService['current']>) =>
      new CurrencyController({ current: () => snapshot } as FxRatesService);
    const snapshot = {
      rates: fullRates(),
      fetchedAt: new Date('2026-11-14T00:00:00Z'),
      source: 'test',
    };

    it('suggests the local currency with rates attached', () => {
      const res = controller(snapshot).context('US');
      expect(res).toMatchObject({
        country: 'US',
        currency: 'USD',
        base: 'BDT',
      });
      expect(res.rates.USD).toBe(0.01);
    });

    it('falls back to BDT when the country is unknown', () => {
      expect(controller(snapshot).context(undefined).currency).toBe('BDT');
      expect(controller(snapshot).context('XX').currency).toBe('BDT');
    });

    it('falls back to BDT with no rates when none are usable', () => {
      const res = controller(null).context('US');
      expect(res).toMatchObject({ currency: 'BDT', rates: {}, asOf: null });
      expect(res.currencies).toEqual([]);
    });
  });
});
