import { ConflictException } from '@nestjs/common';
import type { DrizzleDB } from '../../database/drizzle.types';
import type { GatewayPaymentRow, ShopDraftRow } from '../../database/schema';
import { DRAFT_HOLD_MS, ShopOpeningService } from './shop-opening.service';
import type { CreateShopDto } from './dto/create-shop.dto';

const OWNER = 'owner-1';
const payload: CreateShopDto = {
  name: 'Test Shop',
  handle: 'test-shop',
  cat: 'Other',
  brandId: 'amber',
  supportEmail: 'support@example.com',
  supportPhone: '+8801712345678',
};

function draft(over: Partial<ShopDraftRow> = {}): ShopDraftRow {
  return {
    id: 'draft-1',
    ownerId: OWNER,
    handle: 'test-shop',
    name: 'Test Shop',
    payload: payload as unknown as Record<string, unknown>,
    packCode: 'credit-100k',
    couponCode: null,
    status: 'pending',
    shopId: null,
    expiresAt: new Date(Date.now() + DRAFT_HOLD_MS),
    paidAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as ShopDraftRow;
}

function session(over: Partial<GatewayPaymentRow> = {}): GatewayPaymentRow {
  return {
    id: 'sess-1',
    purpose: 'shop_opening',
    orderId: null,
    shopId: null,
    shopDraftId: 'draft-1',
    packCode: 'credit-100k',
    couponCode: null,
    discountCents: 0,
    refSlug: null,
    provider: 'sslcommerz',
    paymentId: 'SHOP-1',
    status: 'created',
    amountCents: 189900,
    trxId: null,
    payerReference: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as GatewayPaymentRow;
}

/**
 * The db is driven through two shapes only - `query.<table>.findFirst` and
 * the update/insert chains - so the fake answers those and records what was
 * asked. `claims` is the queue of rows successive claiming updates return,
 * which is how "two notifications about one payment" is expressed.
 */
function harness(
  options: {
    claims?: ShopDraftRow[][];
    found?: ShopDraftRow;
    /** A shop this seller already opened under the draft's name. */
    openShop?: { id: string };
  } = {},
) {
  const claims = options.claims ? [...options.claims] : [[draft()]];
  const updates: Record<string, unknown>[] = [];
  const inserted: Record<string, unknown>[] = [];
  const db = {
    query: {
      shopDrafts: { findFirst: jest.fn().mockResolvedValue(options.found) },
      shops: { findFirst: jest.fn().mockResolvedValue(options.openShop) },
      users: {
        findFirst: jest.fn().mockResolvedValue({
          name: 'Seller',
          email: 'seller@example.com',
          phone: '+8801712345678',
        }),
      },
    },
    update: jest.fn(() => ({
      set: (values: Record<string, unknown>) => {
        updates.push(values);
        return {
          where: () => ({
            returning: () => Promise.resolve(claims.shift() ?? []),
            then: (resolve: (v: unknown) => unknown) => resolve(undefined),
          }),
        };
      },
    })),
    insert: jest.fn(() => ({
      values: (values: Record<string, unknown>) => {
        inserted.push(values);
        return {
          onConflictDoNothing: () => ({
            returning: () => Promise.resolve([draft(values as never)]),
          }),
        };
      },
    })),
  };
  const shops = {
    prepareShop: jest.fn().mockResolvedValue({ handle: 'test-shop', ownerId: OWNER }),
    assertContactVerified: jest.fn().mockResolvedValue(undefined),
    createPreparedShop: jest.fn().mockResolvedValue({
      id: 'shop-1',
      ...payload,
      currency: 'BDT',
      language: 'en',
      brand: '#e8943a',
      brandSoft: '#fbeede',
      plan: 'paid',
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    getById: jest.fn().mockResolvedValue({ id: 'shop-1' }),
  };
  const subscriptions = {
    grantPurchasedCredit: jest.fn().mockResolvedValue(undefined),
    settleRepeatOpening: jest.fn().mockResolvedValue('replaced'),
  };
  const billing = {
    packByCode: jest.fn().mockResolvedValue({
      code: 'credit-100k',
      name: '৳1,00,000 in sales',
      priceCents: 189900,
      salesCreditCents: 10000000,
      active: true,
    }),
  };
  const coupons = {
    check: jest.fn().mockResolvedValue({
      ok: true,
      coupon: { id: 'c1', code: 'LAUNCH100' },
      discountCents: 189900,
    }),
  };
  const gatewayCheckout = {
    available: jest.fn().mockResolvedValue(['sslcommerz']),
    label: () => 'SSLCommerz',
    open: jest.fn().mockResolvedValue({ paymentUrl: 'https://pay.example/1' }),
  };
  const service = new ShopOpeningService(
    db as unknown as DrizzleDB,
    shops as never,
    subscriptions as never,
    billing as never,
    coupons as never,
    gatewayCheckout as never,
  );
  return { service, db, shops, subscriptions, gatewayCheckout, updates, inserted };
}

describe('opening a shop is a purchase', () => {
  it('holds the handle for an hour instead of creating a shop', async () => {
    const h = harness();
    const view = await h.service.start(OWNER, payload);
    expect(h.shops.createPreparedShop).not.toHaveBeenCalled();
    expect(h.inserted[0]).toMatchObject({ handle: 'test-shop', ownerId: OWNER });
    const held = new Date(view.expiresAt).getTime() - Date.now();
    expect(held).toBeGreaterThan(DRAFT_HOLD_MS - 5000);
    expect(held).toBeLessThanOrEqual(DRAFT_HOLD_MS);
  });

  it('writes the shop and grants the pack when the money lands', async () => {
    const h = harness();
    await h.service.settlePaidDraft(session(), {
      transactionId: 'txn-1',
      gatewayTxnId: 'BANK-1',
    });
    expect(h.shops.createPreparedShop).toHaveBeenCalledTimes(1);
    expect(h.subscriptions.grantPurchasedCredit).toHaveBeenCalledWith(
      expect.objectContaining({ shopId: 'shop-1', packCode: 'credit-100k' }),
      expect.objectContaining({ gatewayTxnId: 'BANK-1' }),
    );
  });

  // A gateway tells you about one payment twice - by redirect and by IPN -
  // and two shops from one purchase is the failure that matters here.
  it('opens one shop however many times the gateway reports the payment', async () => {
    const h = harness({ claims: [[draft()], []] });
    const charge = { transactionId: 'txn-1', gatewayTxnId: 'BANK-1' };
    await h.service.settlePaidDraft(session(), charge);
    await h.service.settlePaidDraft(session(), charge);
    expect(h.shops.createPreparedShop).toHaveBeenCalledTimes(1);
  });

  it('refuses to take money for a hold that has lapsed', async () => {
    const h = harness({
      found: draft({ expiresAt: new Date(Date.now() - 1000) }),
    });
    await expect(
      h.service.pay(OWNER, 'draft-1', { packCode: 'credit-100k' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(h.gatewayCheckout.open).not.toHaveBeenCalled();
  });

  it('opens the shop on the spot when a coupon covers the whole pack', async () => {
    const h = harness({ found: draft() });
    const result = await h.service.pay(OWNER, 'draft-1', {
      packCode: 'credit-100k',
      couponCode: 'LAUNCH100',
    });
    expect(result.paymentUrl).toBeNull();
    expect(h.gatewayCheckout.open).not.toHaveBeenCalled();
    expect(h.shops.createPreparedShop).toHaveBeenCalledTimes(1);
  });

  // Past the hour the name may have gone to somebody else. The seller has
  // paid, so the shop still opens - on a temporary link if it must.
  it('opens the shop for a payment that lands after the hold lapsed', async () => {
    const h = harness({ claims: [[draft({ status: 'paid' })]] });
    await h.service.settlePaidDraft(session(), {
      transactionId: 'txn-1',
      gatewayTxnId: 'BANK-1',
    });
    expect(h.shops.prepareShop).toHaveBeenCalledWith(OWNER, expect.anything(), {
      paid: true,
    });
    expect(h.shops.createPreparedShop).toHaveBeenCalledTimes(1);
  });

  // They started over, paid for the same name on a new hold, and then the
  // old payment landed too: that is one shop paid for twice, not two shops.
  it('does not open a second shop under a name the seller already opened', async () => {
    const h = harness({ openShop: { id: 'shop-9' } });
    await h.service.settlePaidDraft(session(), {
      transactionId: 'txn-2',
      gatewayTxnId: 'BANK-2',
    });
    expect(h.shops.createPreparedShop).not.toHaveBeenCalled();
    expect(h.subscriptions.settleRepeatOpening).toHaveBeenCalledWith(
      expect.objectContaining({ shopId: 'shop-9', gatewayTxnId: 'BANK-2' }),
    );
  });

  // Two tabs, two payment pages, both paid: the second is not dropped.
  it('hands a second payment for an opened shop to billing', async () => {
    const h = harness({
      claims: [[]],
      found: draft({ status: 'paid', shopId: 'shop-1' }),
    });
    await h.service.settlePaidDraft(session(), {
      transactionId: 'txn-3',
      gatewayTxnId: 'BANK-3',
    });
    expect(h.shops.createPreparedShop).not.toHaveBeenCalled();
    expect(h.subscriptions.settleRepeatOpening).toHaveBeenCalledWith(
      expect.objectContaining({
        shopId: 'shop-1',
        shopDraftId: 'draft-1',
        gatewayTxnId: 'BANK-3',
      }),
    );
  });

  it('never opens a shop the payment session does not name', async () => {
    const h = harness();
    await h.service.settlePaidDraft(session({ shopDraftId: null }), {
      transactionId: null,
      gatewayTxnId: 'BANK-9',
    });
    expect(h.shops.createPreparedShop).not.toHaveBeenCalled();
  });
});
