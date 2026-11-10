import { CommerceService } from './commerce.service';
import { OrdersService } from '../orders/orders.service';
import { ProductResponse } from '../products/dto/product.response';
import { addOrderForSettlement } from '../settlements/settlements.service';
import { emptyBuckets } from '../settlements/settlement-core';
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
      addOrderForSettlement(supplier, order, 'supplier');
      addOrderForSettlement(reseller, order, 'reseller');
      expect(supplier.totalCents).toBe(50000 - margin);
      expect(reseller.totalCents).toBe(margin);
      expect(supplier.totalCents + reseller.totalCents).toBe(order.totalCents);
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
