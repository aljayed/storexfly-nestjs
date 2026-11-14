/**
 * Currencies a buyer can *read* prices in.
 *
 * Separate from SUPPORTED_CURRENCIES (what a shop prices in): this is display
 * only. An order is still placed and charged in the shop's own currency; the
 * storefront converts the figure on screen with the day's rate and says so at
 * checkout. Kept to currencies with a dependable daily rate, so a visitor is
 * never quoted in something we cannot convert well - everyone else reads USD.
 */
export const DISPLAY_CURRENCIES = [
  'BDT',
  'USD',
  'EUR',
  'GBP',
  'INR',
  'PKR',
  'AED',
  'SAR',
  'QAR',
  'KWD',
  'OMR',
  'BHD',
  'MYR',
  'SGD',
  'CAD',
  'AUD',
  'NZD',
  'JPY',
  'CNY',
  'HKD',
  'KRW',
  'THB',
  'IDR',
  'PHP',
  'VND',
  'NPR',
  'LKR',
  'TRY',
  'CHF',
  'SEK',
  'NOK',
  'DKK',
  'PLN',
  'ZAR',
  'EGP',
  'BRL',
  'MXN',
] as const;

export type DisplayCurrency = (typeof DISPLAY_CURRENCIES)[number];

/** What every rate is quoted against, and what a visitor we cannot place sees. */
export const BASE_DISPLAY_CURRENCY: DisplayCurrency = 'BDT';

/** What a visitor from a country without a listed currency reads. */
export const INTERNATIONAL_FALLBACK_CURRENCY: DisplayCurrency = 'USD';

const EUROZONE = [
  'AT',
  'BE',
  'BG',
  'CY',
  'DE',
  'EE',
  'ES',
  'FI',
  'FR',
  'GR',
  'HR',
  'IE',
  'IT',
  'LT',
  'LU',
  'LV',
  'MT',
  'NL',
  'PT',
  'SI',
  'SK',
  // Use the euro without being in the union.
  'AD',
  'MC',
  'SM',
  'VA',
  'ME',
  'XK',
];

/** ISO 3166-1 alpha-2 country → the currency its residents think in. */
const COUNTRY_CURRENCY: Record<string, DisplayCurrency> = {
  BD: 'BDT',
  US: 'USD',
  PR: 'USD',
  GU: 'USD',
  VI: 'USD',
  EC: 'USD',
  SV: 'USD',
  PA: 'USD',
  GB: 'GBP',
  IM: 'GBP',
  JE: 'GBP',
  GG: 'GBP',
  IN: 'INR',
  PK: 'PKR',
  AE: 'AED',
  SA: 'SAR',
  QA: 'QAR',
  KW: 'KWD',
  OM: 'OMR',
  BH: 'BHD',
  MY: 'MYR',
  SG: 'SGD',
  CA: 'CAD',
  AU: 'AUD',
  NZ: 'NZD',
  JP: 'JPY',
  CN: 'CNY',
  HK: 'HKD',
  KR: 'KRW',
  TH: 'THB',
  ID: 'IDR',
  PH: 'PHP',
  VN: 'VND',
  NP: 'NPR',
  LK: 'LKR',
  TR: 'TRY',
  CH: 'CHF',
  LI: 'CHF',
  SE: 'SEK',
  NO: 'NOK',
  DK: 'DKK',
  GL: 'DKK',
  FO: 'DKK',
  PL: 'PLN',
  ZA: 'ZAR',
  EG: 'EGP',
  BR: 'BRL',
  MX: 'MXN',
  ...Object.fromEntries(EUROZONE.map((c) => [c, 'EUR' as const])),
};

/**
 * A two-letter country code from an edge header, or null when it says nothing
 * usable. Cloudflare sends `XX` for an address it cannot place and `T1` for
 * Tor; neither is a country.
 */
export function normalizeCountry(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code) || code === 'XX') return null;
  return code;
}

/**
 * The currency to show a visitor from `country` by default.
 *
 * Unknown country → BDT: the platform's home currency is the honest default
 * when we know nothing. A known foreign country without a listed currency →
 * USD, the one figure an international buyer can always read.
 */
export function currencyForCountry(country: string | null): DisplayCurrency {
  if (!country) return BASE_DISPLAY_CURRENCY;
  return COUNTRY_CURRENCY[country] ?? INTERNATIONAL_FALLBACK_CURRENCY;
}
