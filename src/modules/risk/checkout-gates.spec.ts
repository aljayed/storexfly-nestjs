import { ConfigService } from '@nestjs/config';
import type { DrizzleDB } from '../../database/drizzle.types';
import { orders } from '../../database/schema';
import { RiskService } from './risk.service';

/**
 * The checkout gates never refuse an order, never withhold a payment method
 * and never cap how often anyone may buy. All they do is ask a buyer repeating
 * inside the window who they are, in a fixed order: sign in, then confirm a
 * number. These tests pin that order, pin the cases that must sail through
 * with no steps at all, and pin *which* number the code step is about - the
 * account's for money taken up front, the delivery number for cash on
 * delivery, where nothing has been collected and that number is all anyone
 * has to go on.
 */

interface World {
  /** Orders already delivered to this buyer - any at all makes them trusted. */
  delivered?: number;
  /** Matching order events inside the risk window. */
  priorOrders?: number;
  /** The signed-in account, when there is one. */
  account?: { phone: string | null; phoneVerified: boolean } | null;
}

function riskServiceFor(world: World): RiskService {
  const db = {
    query: {
      users: { findFirst: () => Promise.resolve(world.account ?? null) },
    },
    // Both call sites are `select({...}).from(table).where(...)`; the table is
    // what says whether the question was "delivered before?" or "ordered
    // recently?".
    select: () => ({
      from: (table: unknown) => ({
        where: () =>
          Promise.resolve([
            {
              n:
                table === orders
                  ? (world.delivered ?? 0)
                  : (world.priorOrders ?? 0),
            },
          ]),
      }),
    }),
  } as unknown as DrizzleDB;

  const config = {
    get: () => 'test-secret',
    getOrThrow: () => 'test-secret',
  } as unknown as ConfigService;

  return new RiskService(db, config);
}

const buyer = {
  phone: '+8801575802456',
  email: 'buyer@example.com',
  ip: '203.0.113.9',
  device: 'device-1',
};

describe('checkout identity gates', () => {
  it('asks nothing of a first order in the window', async () => {
    const risk = await riskServiceFor({ priorOrders: 0 }).assessCheckout(buyer);
    expect(risk).toEqual({
      requireLogin: false,
      requirePhoneVerification: false,
    });
  });

  it('asks a repeating guest to sign in first, with the code still to come', async () => {
    const risk = await riskServiceFor({ priorOrders: 1 }).assessCheckout(buyer);
    expect(risk.requireLogin).toBe(true);
    expect(risk.requirePhoneVerification).toBe(true);
    expect(risk.reason).toBe('repeat_contact');
  });

  it('asks only for the code once the buyer is signed in', async () => {
    const risk = await riskServiceFor({
      priorOrders: 1,
      account: { phone: '01575802456', phoneVerified: false },
    }).assessCheckout({ ...buyer, accountId: 'acct-1' });
    expect(risk.requireLogin).toBe(false);
    expect(risk.requirePhoneVerification).toBe(true);
  });

  it('asks nothing of a verified account, however often it orders', async () => {
    const risk = await riskServiceFor({
      priorOrders: 3,
      account: { phone: '+8801575802456', phoneVerified: true },
    }).assessCheckout({ ...buyer, accountId: 'acct-1' });
    expect(risk.requireLogin).toBe(false);
    expect(risk.requirePhoneVerification).toBe(false);
  });

  // Paid up front, the code proves a person is behind the account, once. It is
  // not re-run against the delivery number, so a gift to someone else's phone
  // is not a reason to ask an already-verified buyer all over again.
  it('asks nothing of a verified account prepaying to a different number', async () => {
    const risk = await riskServiceFor({
      priorOrders: 1,
      account: { phone: '+8801711111111', phoneVerified: true },
    }).assessCheckout({ ...buyer, accountId: 'acct-1' });
    expect(risk.requirePhoneVerification).toBe(false);
  });

  /* ── Cash on delivery: the question moves to the delivery number ──
     Nothing has been collected and the seller is about to pay a courier out
     of pocket, so what matters is whether anyone answers at the number the
     parcel is going to - not whether this account once proved some other one. */

  it('asks a verified account to confirm a delivery number it has not proved, for COD', async () => {
    const risk = await riskServiceFor({
      priorOrders: 1,
      account: { phone: '+8801711111111', phoneVerified: true },
    }).assessCheckout({
      ...buyer,
      accountId: 'acct-1',
      cashOnDelivery: true,
    });
    expect(risk.requirePhoneVerification).toBe(true);
  });

  // The autofilled number left alone is the one they already proved, however
  // differently it happens to be written - so COD costs them nothing.
  it('asks nothing for COD to the number the account already proved', async () => {
    const risk = await riskServiceFor({
      priorOrders: 1,
      account: { phone: '01575802456', phoneVerified: true },
    }).assessCheckout({
      ...buyer,
      accountId: 'acct-1',
      cashOnDelivery: true,
    });
    expect(risk.requirePhoneVerification).toBe(false);
  });

  // The 15% advance is on the COD track but still moves real money through a
  // gateway before dispatch, which is the assurance the code stands in for.
  it('treats a prepaid order to an unproved number as prepaid, not COD', async () => {
    const risk = await riskServiceFor({
      priorOrders: 1,
      account: { phone: '+8801711111111', phoneVerified: true },
    }).assessCheckout({
      ...buyer,
      accountId: 'acct-1',
      cashOnDelivery: false,
    });
    expect(risk.requirePhoneVerification).toBe(false);
  });

  // Outside the window there is no gate at all, so COD to a brand-new number
  // is not a reason to invent one. The seller's own signed-in-only switch is
  // the lever for a shop that wants more than this, and it lives on the shop.
  it('asks nothing for COD to an unproved number outside the window', async () => {
    const risk = await riskServiceFor({
      priorOrders: 0,
      account: { phone: '+8801711111111', phoneVerified: true },
    }).assessCheckout({
      ...buyer,
      accountId: 'acct-1',
      cashOnDelivery: true,
    });
    expect(risk).toEqual({
      requireLogin: false,
      requirePhoneVerification: false,
    });
  });

  it('exempts a buyer who has taken a delivery, however often they order', async () => {
    const risk = await riskServiceFor({
      delivered: 1,
      priorOrders: 5,
    }).assessCheckout(buyer);
    expect(risk).toEqual({
      requireLogin: false,
      requirePhoneVerification: false,
    });
  });
});
