import {
  commerceUnitPrice,
  resellerVariantCombinations,
  validateCommerce,
} from './commerce';
import type { CommercePolicy } from './commerce';
const policy: CommercePolicy = {
  channels: ['retail', 'reseller', 'wholesale'],
  resellerPriceCents: 30000,
  wholesaleMoq: 10,
  wholesaleTiers: [
    { minQty: 10, unitPriceCents: 27000 },
    { minQty: 100, unitPriceCents: 23000 },
  ],
};
describe('Shared commerce pricing', () => {
  it('preserves retail defaults for existing products', () =>
    expect(commerceUnitPrice(undefined, 'retail', 1, 50000)).toBe(50000));
  it('uses the supplier price for reseller procurement', () =>
    expect(commerceUnitPrice(policy, 'reseller', 1, 50000)).toBe(30000));
  it.each([
    [10, 27000],
    [99, 27000],
    [100, 23000],
    [1000, 23000],
  ])('prices %i wholesale units at %i cents', (qty, price) =>
    expect(commerceUnitPrice(policy, 'wholesale', qty, 50000)).toBe(price),
  );
  it('enforces the minimum quantity and channel eligibility', () => {
    expect(() => commerceUnitPrice(policy, 'wholesale', 9, 50000)).toThrow(
      'Minimum wholesale',
    );
    expect(() => commerceUnitPrice(undefined, 'reseller', 1, 50000)).toThrow(
      'not available',
    );
  });
  it.each([
    { channels: [] },
    { channels: ['retail', 'retail'] },
    { channels: ['reseller'] },
    { ...policy, resellerPriceCents: -1 },
    { ...policy, wholesaleMoq: 0 },
    { ...policy, wholesaleTiers: [{ minQty: 11, unitPriceCents: 100 }] },
    {
      ...policy,
      wholesaleTiers: [
        { minQty: 10, unitPriceCents: 100 },
        { minQty: 10, unitPriceCents: 90 },
      ],
    },
    {
      ...policy,
      wholesaleTiers: [
        { minQty: 10, unitPriceCents: 100 },
        { minQty: 20, unitPriceCents: 110 },
      ],
    },
  ])('refuses invalid selling policies', (bad) =>
    expect(() => validateCommerce(bad as CommercePolicy)).toThrow(),
  );
  it('normalizes tier order while preserving integer money', () =>
    expect(
      validateCommerce({
        ...policy,
        wholesaleTiers: [...policy.wholesaleTiers!].reverse(),
      }).wholesaleTiers,
    ).toEqual(policy.wholesaleTiers));
});

describe('resellerVariantCombinations', () => {
  const product = {
    priceCents: 50000,
    variantCombinations: [
      { id: 'a', priceCents: 50000, comparePriceCents: 60000 },
      { id: 'b', priceCents: 10000, comparePriceCents: null },
    ],
  };
  it('shifts every variant by the markup over retail and drops compare prices', () =>
    expect(resellerVariantCombinations(product, 55000)).toEqual([
      { id: 'a', priceCents: 55000, comparePriceCents: null },
      { id: 'b', priceCents: 15000, comparePriceCents: null },
    ]));
  it('never advertises a negative variant when priced below retail', () =>
    expect(
      resellerVariantCombinations(product, 35000).map((v) => v.priceCents),
    ).toEqual([35000, 0]));
});
