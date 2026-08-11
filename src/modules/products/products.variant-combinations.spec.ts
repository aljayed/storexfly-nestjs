import { BadRequestException } from '@nestjs/common';
import type {
  ProductRow,
  ProductVariantCombination,
  ProductVariantGroup,
} from '../../database/schema';
import { ProductsService } from './products.service';

const groups: ProductVariantGroup[] = [
  {
    id: 'size',
    name: 'Size',
    options: [
      { id: 'sm', label: 'S', priceDeltaCents: 0 },
      { id: 'lg', label: 'L', priceDeltaCents: 0 },
    ],
  },
];

const combinations: ProductVariantCombination[] = [
  {
    id: 'row-sm',
    optionIds: { size: 'sm' },
    priceCents: 90_000,
    comparePriceCents: 120_000,
    stock: 4,
    available: true,
  },
  {
    id: 'row-lg',
    optionIds: { size: 'lg' },
    priceCents: 110_000,
    stock: 7,
    available: true,
  },
];

const current = {
  id: 'p1',
  shopId: 's1',
  name: 'Tee',
  listingType: 'sale',
  priceCents: 90_000,
  comparePriceCents: 120_000,
  // 4 + 7, kept in step with the rows.
  stock: 11,
  variantGroups: groups,
  variantCombinations: combinations,
  packs: [],
} as unknown as ProductRow;

/**
 * `update` only needs to find the product and write a patch back; the returned
 * row is mapped by `ProductResponse.fromRow`, so it has to look like one.
 */
function serviceFor(row: ProductRow) {
  let patch: Partial<ProductRow> | undefined;
  const db = {
    query: { products: { findFirst: () => Promise.resolve(row) } },
    update: () => ({
      set: (p: Partial<ProductRow>) => ({
        where: () => ({
          returning: () => {
            patch = p;
            return Promise.resolve([{ ...row, ...p }]);
          },
        }),
      }),
    }),
  };
  const service = new ProductsService(
    db as never,
    null as never,
    { absorb: (v: string) => Promise.resolve(v), absorbMany: () => undefined },
    null as never,
  );
  return { service, written: () => patch };
}

describe('ProductsService exact variant combinations', () => {
  it('derives price and stock from the rows on a patch that never mentions variants', async () => {
    const { service, written } = serviceFor(current);
    // A partial update - a rename, a tag, a bulk stock edit - must not be able
    // to leave `stock`/`price` disagreeing with the rows checkout reads.
    await service.update('s1', 'p1', {
      name: 'Tee v2',
      price: 5,
      stock: 999,
    });
    expect(written()?.stock).toBe(11);
    expect(written()?.priceCents).toBe(90_000);
    expect(written()?.comparePriceCents).toBe(120_000);
  });

  it('totals only the rows that are actually for sale', async () => {
    const { service, written } = serviceFor(current);
    await service.update('s1', 'p1', {
      variantCombinations: [
        {
          id: 'row-sm',
          optionIds: { size: 'sm' },
          price: 900,
          stock: 4,
          available: false,
        },
        {
          id: 'row-lg',
          optionIds: { size: 'lg' },
          price: 1100,
          stock: 7,
          available: true,
        },
      ],
    });
    expect(written()?.stock).toBe(7);
    // The cheapest *sellable* row drives the catalog card.
    expect(written()?.priceCents).toBe(110_000);
  });

  it('hands stock back to the seller when the rows are cleared', async () => {
    const { service, written } = serviceFor(current);
    await service.update('s1', 'p1', {
      variantCombinations: [],
      stock: 25,
      price: 12,
    });
    expect(written()?.variantCombinations).toEqual([]);
    expect(written()?.stock).toBe(25);
    // With no rows left, the seller's own price is authoritative again.
    expect(written()?.priceCents).toBe(1_200);
  });

  it('drops the rows when the groups are replaced without them', async () => {
    const { service, written } = serviceFor(current);
    await service.update('s1', 'p1', {
      variantGroups: [
        {
          id: 'colour',
          name: 'Colour',
          options: [{ id: 'red', label: 'Red' }],
        },
      ],
      stock: 30,
    });
    expect(written()?.variantCombinations).toEqual([]);
    expect(written()?.stock).toBe(30);
  });

  it('accepts an explicit subset of the possible pairings', async () => {
    const { service, written } = serviceFor(current);
    await service.update('s1', 'p1', {
      variantCombinations: [
        { optionIds: { size: 'sm' }, price: 900, stock: 4, available: true },
      ],
    });
    expect(written()?.variantCombinations).toHaveLength(1);
    expect(written()?.stock).toBe(4);
  });

  it('rejects a third option group unless the item sells exact rows', async () => {
    const { service } = serviceFor(current);
    const threeGroups = [
      { id: 'size', name: 'Size', options: [{ id: 'sm', label: 'S' }] },
      { id: 'colour', name: 'Colour', options: [{ id: 'red', label: 'Red' }] },
      { id: 'fit', name: 'Fit', options: [{ id: 'slim', label: 'Slim' }] },
    ];
    await expect(
      service.update('s1', 'p1', {
        variantGroups: threeGroups,
      }),
    ).rejects.toThrow(BadRequestException);

    const { service: ok, written } = serviceFor(current);
    await ok.update('s1', 'p1', {
      variantGroups: threeGroups,
      variantCombinations: [
        {
          optionIds: { size: 'sm', colour: 'red', fit: 'slim' },
          price: 900,
          stock: 3,
          available: true,
        },
      ],
    });
    expect(written()?.stock).toBe(3);
  });

  it('refuses two rows describing the same pairing', async () => {
    const { service } = serviceFor(current);
    await expect(
      service.update('s1', 'p1', {
        variantCombinations: [
          { optionIds: { size: 'sm' }, price: 900, stock: 1, available: true },
          { optionIds: { size: 'sm' }, price: 950, stock: 1, available: true },
        ],
      }),
    ).rejects.toThrow(BadRequestException);
  });
});
