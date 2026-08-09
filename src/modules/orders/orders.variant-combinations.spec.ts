import { ConflictException } from '@nestjs/common';
import type {
  ProductRow,
  ProductVariantCombination,
  ProductVariantGroup,
} from '../../database/schema';
import { OrdersService } from './orders.service';

type PricePick = (
  product: ProductRow,
  pick: { qty: number; variant?: Record<string, string>; packId?: string },
  payKind: string | null,
) => {
  line: { unitPriceCents: number; variantCombinationId?: string | null };
  combinationId: string | null;
};

interface VariantDeduction {
  productId: string;
  variantPick: Record<string, string>;
  combinationId?: string | null;
  units: number;
}

type ApplyVariantStock = (
  tx: unknown,
  deductions: VariantDeduction[],
  sign: 1 | -1,
) => Promise<void>;

/** What `applyVariantStock` wrote back to the product row. */
interface StockPatch {
  variantGroups?: ProductVariantGroup[];
  variantCombinations?: ProductVariantCombination[];
  stock?: number;
}

/**
 * Just enough of the drizzle transaction for `applyVariantStock`: one locked
 * `select … for update` of the product, then one `update … set`.
 */
function fakeTx(row: {
  variantGroups?: ProductVariantGroup[];
  variantCombinations?: ProductVariantCombination[];
}) {
  const writes: StockPatch[] = [];
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({ for: () => Promise.resolve([row]) }),
      }),
    }),
    update: () => ({
      set: (patch: StockPatch) => ({
        where: () => {
          writes.push(patch);
          return Promise.resolve();
        },
      }),
    }),
  };
  return { tx, writes };
}

describe('OrdersService exact variant combinations', () => {
  const service = new OrdersService(
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
  );
  const internals = service as unknown as {
    priceProductPick: PricePick;
    applyVariantStock: ApplyVariantStock;
  };
  const pricePick: PricePick = (product, pick, payKind) =>
    internals.priceProductPick(product, pick, payKind);
  const applyVariantStock: ApplyVariantStock = (tx, deductions, sign) =>
    internals.applyVariantStock(tx, deductions, sign);

  const variantGroups: ProductVariantGroup[] = [
    {
      id: 'ram',
      name: 'RAM',
      options: [
        { id: 'ram-8', label: '8 GB', priceDeltaCents: 0 },
        { id: 'ram-16', label: '16 GB', priceDeltaCents: 700_000 },
      ],
    },
    {
      id: 'ssd',
      name: 'Storage',
      options: [
        { id: 'ssd-256', label: '256 GB', priceDeltaCents: 0 },
        { id: 'ssd-512', label: '512 GB', priceDeltaCents: 450_000 },
      ],
    },
  ];

  // The API only ever stores a complete grid, so a pairing that isn't made is
  // present with `available: false` rather than missing.
  const variantCombinations: ProductVariantCombination[] = [
    {
      id: 'pc-8-256',
      optionIds: { ram: 'ram-8', ssd: 'ssd-256' },
      priceCents: 3_800_000,
      stock: 6,
      available: true,
    },
    {
      id: 'pc-8-512',
      optionIds: { ram: 'ram-8', ssd: 'ssd-512' },
      priceCents: 4_100_000,
      stock: 4,
      available: true,
    },
    {
      id: 'pc-16-256',
      optionIds: { ram: 'ram-16', ssd: 'ssd-256' },
      priceCents: 4_400_000,
      stock: 9,
      available: false,
    },
    {
      id: 'pc-16-512',
      optionIds: { ram: 'ram-16', ssd: 'ssd-512' },
      priceCents: 4_950_000,
      stock: 6,
      available: true,
    },
  ];

  const product = {
    id: 'pc',
    name: 'Desktop PC',
    listingType: 'sale',
    paymentMethods: ['cod'],
    priceCents: 3_800_000,
    // Aggregate = the sellable rows: 6 + 4 + 6. The disabled row doesn't count.
    stock: 16,
    packs: [
      { id: 'three', label: 'Pack of 3', units: 3, priceCents: 10_000_000 },
    ],
    variantGroups,
    variantCombinations,
  } as unknown as ProductRow;

  describe('pricing a pick', () => {
    it('prices and identifies the exact selected row', () => {
      const result = pricePick(
        product,
        { qty: 1, variant: { ram: 'ram-16', ssd: 'ssd-512' } },
        null,
      );
      expect(result.line.unitPriceCents).toBe(4_950_000);
      expect(result.line.variantCombinationId).toBe('pc-16-512');
      expect(result.combinationId).toBe('pc-16-512');
    });

    it('applies an exact row delta once per unit in a multi-buy pack', () => {
      const result = pricePick(
        product,
        {
          qty: 1,
          variant: { ram: 'ram-16', ssd: 'ssd-512' },
          packId: 'three',
        },
        null,
      );
      expect(result.line.unitPriceCents).toBe(13_450_000);
    });

    it('rejects a quantity above the exact row stock', () => {
      expect(() =>
        pricePick(
          product,
          { qty: 7, variant: { ram: 'ram-16', ssd: 'ssd-512' } },
          null,
        ),
      ).toThrow(ConflictException);
    });

    it('refuses a row the seller has switched off', () => {
      expect(() =>
        pricePick(
          product,
          { qty: 1, variant: { ram: 'ram-16', ssd: 'ssd-256' } },
          null,
        ),
      ).toThrow(ConflictException);
    });

    it('keeps legacy additive pricing when no exact rows exist', () => {
      const legacy = { ...product, variantCombinations: [] } as ProductRow;
      const result = pricePick(
        legacy,
        { qty: 1, variant: { ram: 'ram-16', ssd: 'ssd-512' } },
        null,
      );
      expect(result.line.unitPriceCents).toBe(4_950_000);
      expect(result.combinationId).toBeNull();
    });
  });

  describe('moving stock', () => {
    const pick = { ram: 'ram-16', ssd: 'ssd-512' };

    it('takes units off the exact row and recomputes the aggregate', async () => {
      const { tx, writes } = fakeTx({
        variantGroups,
        variantCombinations,
      });
      await applyVariantStock(
        tx,
        [
          {
            productId: 'pc',
            variantPick: pick,
            combinationId: 'pc-16-512',
            units: 2,
          },
        ],
        -1,
      );
      const written = writes[0];
      expect(
        written.variantCombinations?.find((c) => c.id === 'pc-16-512')?.stock,
      ).toBe(4);
      // 6 + 4 + 4; the disabled row stays out of the total.
      expect(written.stock).toBe(14);
    });

    it('sums two lines that moved the same row, whatever order the pick keys came back in', async () => {
      const { tx, writes } = fakeTx({
        variantGroups,
        variantCombinations,
      });
      await applyVariantStock(
        tx,
        [
          {
            productId: 'pc',
            variantPick: { ram: 'ram-16', ssd: 'ssd-512' },
            combinationId: 'pc-16-512',
            units: 2,
          },
          {
            productId: 'pc',
            // Read back out of jsonb, so Postgres' key order, not ours.
            variantPick: { ssd: 'ssd-512', ram: 'ram-16' },
            combinationId: 'pc-16-512',
            units: 3,
          },
        ],
        -1,
      );
      expect(
        writes[0].variantCombinations?.find((c) => c.id === 'pc-16-512')?.stock,
      ).toBe(1);
    });

    it('refuses to take more than the exact row holds', async () => {
      const { tx } = fakeTx({ variantGroups, variantCombinations });
      await expect(
        applyVariantStock(
          tx,
          [
            {
              productId: 'pc',
              variantPick: pick,
              combinationId: 'pc-16-512',
              units: 7,
            },
          ],
          -1,
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('invents nothing when the cancelled row is gone but others remain', async () => {
      // The seller deleted the exact row between checkout and cancellation.
      const { tx, writes } = fakeTx({
        variantGroups,
        variantCombinations: variantCombinations.filter(
          (c) => c.id !== 'pc-16-512',
        ),
      });
      await applyVariantStock(
        tx,
        [
          {
            productId: 'pc',
            variantPick: pick,
            combinationId: 'pc-16-512',
            units: 2,
          },
        ],
        1,
      );
      // Recomputed from what's left (6 + 4), so the caller's optimistic
      // aggregate increment is discarded rather than doubling the catalog.
      expect(writes[0].stock).toBe(10);
    });

    it('leaves the aggregate alone once the product has left the exact model', async () => {
      // No exact rows at all: the units belong back on `products.stock`, which
      // the caller has already incremented - so this must not overwrite it.
      const { tx, writes } = fakeTx({
        variantGroups,
        variantCombinations: [],
      });
      await applyVariantStock(
        tx,
        [
          {
            productId: 'pc',
            variantPick: pick,
            combinationId: 'pc-16-512',
            units: 2,
          },
        ],
        1,
      );
      expect(writes[0].stock).toBeUndefined();
    });

    it('moves legacy per-option counters and never the exact rows', async () => {
      const tracked: ProductVariantGroup[] = [
        {
          id: 'size',
          name: 'Size',
          options: [
            { id: 'sm', label: 'S', priceDeltaCents: 0, stock: 5 },
            { id: 'lg', label: 'L', priceDeltaCents: 0, stock: 5 },
          ],
        },
      ];
      const { tx, writes } = fakeTx({
        variantGroups: tracked,
        variantCombinations: [],
      });
      await applyVariantStock(
        tx,
        [
          {
            productId: 'p',
            variantPick: { size: 'lg' },
            combinationId: null,
            units: 2,
          },
        ],
        -1,
      );
      const options = writes[0].variantGroups?.[0].options;
      expect(options?.find((o) => o.id === 'lg')?.stock).toBe(3);
      expect(options?.find((o) => o.id === 'sm')?.stock).toBe(5);
      expect(writes[0].stock).toBeUndefined();
    });
  });
});
