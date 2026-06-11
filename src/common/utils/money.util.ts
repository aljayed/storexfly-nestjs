/**
 * Money helpers. Internally money is stored as integer cents to avoid
 * floating-point drift; the API contract (`models.ts`) exposes decimal dollars.
 */

export function dollarsToCents(dollars: number): number {
  return Math.round(dollars * 100);
}

export function centsToDollars(cents: number): number {
  return Math.round(cents) / 100;
}
