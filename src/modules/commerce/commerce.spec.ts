import { CommerceService } from './commerce.service';
import { OrdersService } from '../orders/orders.service';
import { ProductResponse } from '../products/dto/product.response';
import {
  addOrderForSettlement,
  resellerMarginPayout,
  shareOf,
} from '../settlements/settlements.service';
import {
  classify,
  emptyBuckets,
  payoutCents,
} from '../settlements/settlement-core';
import type { CheckoutDto } from '../orders/dto/checkout.dto';
import type { ProductRow } from '../../database/schema';
const source = {
  id: 'product',
  shopId: 'supplier',
  name: 'Phone cover',
  priceCents: 50000,
  stock: 1000,
  listingType: 'sale',
  variantGroups: [],
  variantCombinations: [],
  packs: [],
  commerce: {
    channels: ['retail', 'reseller', 'wholesale'],
    resellerPriceCents: 30000,
    wholesaleMoq: 10,
    wholesaleTiers: [
      { minQty: 10, unitPriceCents: 27000 },
      { minQty: 100, unitPriceCents: 23000 },
    ],
  },
} as unknown as ProductRow;
const internals = Object.create(OrdersService.prototype) as {
  db: unknown;
  priceProductPick: (
    p: ProductRow,
    pick: object,
    pay: string | null,
    mode?: string,
    quotePrice?: number,
  ) => { line: { unitPriceCents: number }; units: number };
  validateTradeQuote: (
    dto: CheckoutDto,
    account: string | null,
  ) => Promise<void>;
  resellerCheckoutContext: (
    dto: CheckoutDto,
    account: string | null,
  ) => Promise<unknown>;
};
describe('Commerce order invariants', () => {
  it('applies wholesale price and exact variant delta once', () => {
    const product = {
      ...source,
      variantGroups: [
        {
          id: 'color',
          name: 'Color',
          options: [{ id: 'red', label: 'Red', priceDeltaCents: 500 }],
        },
      ],
    };
    const priced = internals.priceProductPick(
      product,
      { qty: 100, variant: { color: 'red' } },
      null,
      'wholesale',
    );
    expect(priced.line.unitPriceCents).toBe(23500);
    expect(priced.units).toBe(100);
  });
  it('keeps reseller pricing correct when a negative variant delta clamps supply cost to zero', () => {
    const product = {
      ...source,
      variantGroups: [
        {
          id: 'size',
          name: 'Size',
          options: [{ id: 'small', label: 'Small', priceDeltaCents: -40000 }],
        },
      ],
    };
    const pick = { qty: 1, variant: { size: 'small' } };
    const supplier = internals.priceProductPick(product, pick, null, 'reseller')
      .line.unitPriceCents;
    const customer = internals.priceProductPick(
      { ...product, priceCents: 45000, commerce: { channels: ['retail'] } },
      pick,
      null,
      'retail',
    ).line.unitPriceCents;
    expect(supplier).toBe(0);
    expect(customer).toBe(5000);
    expect(customer - supplier).toBe(5000);
  });
  it('refuses retail packs as a way around supply pricing', () =>
    expect(() =>
      internals.priceProductPick(
        source,
        { qty: 100, packId: 'pack' },
        null,
        'wholesale',
      ),
    ).toThrow('individual units'));
  it('allows an approved sample at its negotiated final variant price', () =>
    expect(
      internals.priceProductPick(source, { qty: 1 }, null, 'wholesale', 40000)
        .line.unitPriceCents,
    ).toBe(40000));
  it('refuses a quote belonging to another account', async () => {
    internals.db = {
      query: {
        tradeQuotes: { findFirst: jest.fn().mockResolvedValue(undefined) },
      },
    };
    await expect(
      internals.validateTradeQuote(
        {
          tradeQuoteId: 'q',
          productId: 'p',
          shopId: 's',
          qty: 1,
        } as CheckoutDto,
        'other',
      ),
    ).rejects.toThrow('does not match');
  });
  it.each([
    { qty: 11 },
    { variant: { color: 'red' } },
    { usedAt: new Date() },
    { expiresAt: new Date(0) },
  ])(
    'refuses tampered, expired, or consumed accepted quotes',
    async (change) => {
      const quote = {
        shopId: 's',
        productId: 'p',
        qty: 10,
        variant: {},
        usedAt: null,
        status: 'accepted',
        expiresAt: new Date(Date.now() + 60000),
        ...change,
      };
      internals.db = {
        query: {
          tradeQuotes: { findFirst: jest.fn().mockResolvedValue(quote) },
        },
      };
      await expect(
        internals.validateTradeQuote(
          {
            tradeQuoteId: 'q',
            productId: 'p',
            shopId: 's',
            qty: 10,
          } as CheckoutDto,
          'buyer',
        ),
      ).rejects.toThrow();
    },
  );
  it('binds a reseller offer to its advertised store and prevents own purchases', async () => {
    internals.db = {
      query: {
        resellerListings: {
          findFirst: async () => ({
            id: 'listing',
            shopId: 'reseller',
            productId: 'product',
            active: true,
          }),
        },
        products: { findFirst: async () => source },
        shops: {
          findFirst: async () => ({
            id: 'reseller',
            live: true,
            ownerId: 'owner',
          }),
        },
      },
    };
    await expect(
      internals.resellerCheckoutContext(
        {
          resellerListingId: 'listing',
          productId: 'listing',
          shopId: 'wrong',
        } as CheckoutDto,
        null,
      ),
    ).rejects.toThrow('not found');
    await expect(
      internals.resellerCheckoutContext(
        {
          resellerListingId: 'listing',
          productId: 'listing',
          shopId: 'reseller',
        } as CheckoutDto,
        'owner',
      ),
    ).rejects.toThrow('own reseller');
    const dto = {
      resellerListingId: 'listing',
      productId: 'listing',
      shopId: 'reseller',
    } as CheckoutDto;
    await internals.resellerCheckoutContext(dto, null);
    expect(dto.shopId).toBe('supplier');
    expect(dto.productId).toBe('product');
    expect(dto.commerceMode).toBe('reseller');
  });
  it('keeps supplier costs off public product responses', () => {
    const response = ProductResponse.fromRow({
      ...source,
      deliveryDhakaCents: null,
      deliveryOutsideCents: null,
    } as ProductRow);
    expect(JSON.stringify(response)).not.toContain('resellerPrice');
  });
});
describe('Reseller settlement allocation', () => {
  it.each([0, 15000])(
    'allocates collected revenue once with %i cents of margin',
    (margin) => {
      const supplier = emptyBuckets(),
        reseller = emptyBuckets();
      const order = {
        shopId: 'supplier',
        resellerShopId: 'reseller',
        resellerMarginCents: margin,
        totalCents: 50000,
        advanceCents: 0,
        paymentMethod: 'bkash',
        pay: 'Paid',
      };
      const catalog = new Map([
        [
          'bkash',
          {
            code: 'bkash',
            title: 'bKash',
            gateway: 'bkash',
            kind: 'mbank',
            feeBp: 450,
          },
        ],
      ]) as never;
      addOrderForSettlement(supplier, order, 'supplier', catalog);
      addOrderForSettlement(reseller, order, 'reseller');
      expect(supplier.totalCents).toBe(50000);
      expect(supplier.resellerMarginCents).toBe(margin);
      expect(reseller.totalCents).toBe(margin);
      expect(
        payoutCents(classify(supplier, catalog)) +
          payoutCents(classify(reseller, catalog)),
      ).toBe(47750);
    },
  );
});
describe('Quote lifecycle isolation', () => {
  it('cannot accept an unquoted or expired request', async () => {
    const quote = { status: 'quoted', expiresAt: new Date(0), usedAt: null };
    const tx = {
      select: () => ({
        from: () => ({ where: () => ({ for: async () => [quote] }) }),
      }),
    };
    const service = new CommerceService({
      transaction: (fn: (tx: unknown) => unknown) => fn(tx),
    } as never);
    await expect(
      service.decideQuote('buyer', 'quote', 'accept'),
    ).rejects.toThrow('expired');
  });
});
describe('Reseller margin on an order the supplier collected', () => {
  const catalog = new Map([
    [
      'cod',
      {
        code: 'cod',
        kind: 'cod',
        gateway: 'none',
        feeBp: 0,
        title: 'Cash on Delivery',
      },
    ],
    [
      'bkash',
      {
        code: 'bkash',
        kind: 'mbank',
        gateway: 'bkash',
        feeBp: 450,
        title: 'bKash',
      },
    ],
  ]) as never;
  const delivered = new Date('2026-11-02T06:00:00Z');
  const order = {
    shopId: 'supplier',
    resellerShopId: 'reseller',
    resellerMarginCents: 15000,
    totalCents: 50000,
    advanceCents: 0,
    paymentMethod: 'cod',
    pay: 'Paid',
    deliveredAt: delivered,
    handedOverAt: null,
    deliveryMode: 'carrybee' as const,
    duesPaidAt: null as Date | null,
  };

  it('is not payable until the supplier has handed it in', () => {
    expect(resellerMarginPayout(order, catalog)).toBeNull();
    expect(shareOf(order, 'reseller', catalog)).toEqual([]);
  });

  it('is paid out in full without a service fee in the cycle it was handed in', () => {
    const handedIn = new Date('2026-11-20T06:00:00Z');
    const [entry] = shareOf(
      { ...order, duesPaidAt: handedIn },
      'reseller',
      catalog,
    );
    expect(entry.at).toBe(handedIn);
    const bucket = emptyBuckets();
    entry.add(bucket);
    const core = classify(bucket, catalog);
    expect(core.online).toEqual([
      expect.objectContaining({ cents: 15000, feeBp: 0, feeCents: 0 }),
    ]);
    expect(payoutCents(core)).toBe(15000);
  });

  it('leaves the supplier nothing to be paid out - they hold the cash', () => {
    const [entry] = shareOf(order, 'supplier', catalog);
    const bucket = emptyBuckets();
    entry.add(bucket);
    const core = classify(bucket, catalog);
    expect(core.codCents).toBe(50000);
    expect(payoutCents(core)).toBe(0);
  });

  it('still pays an online order from the cycle it was delivered in', () => {
    const online = { ...order, paymentMethod: 'bkash' };
    expect(resellerMarginPayout(online, catalog)).toEqual({
      method: 'reseller-online-margin',
      cents: 15000,
      at: delivered,
    });
  });
});
