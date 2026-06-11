/**
 * Currencies a shop can price in. Stored on the shop as a 3-letter ISO code;
 * the storefront/admin resolve the display symbol client-side. BDT is the
 * default for new shops.
 */
export const SUPPORTED_CURRENCIES = [
  'BDT',
  'USD',
  'EUR',
  'GBP',
  'INR',
  'PKR',
  'AED',
  'SAR',
  'MYR',
  'CAD',
  'AUD',
  'JPY',
] as const;

export type CurrencyCode = (typeof SUPPORTED_CURRENCIES)[number];

export const DEFAULT_CURRENCY: CurrencyCode = 'BDT';
