import { ConfigService } from '@nestjs/config';
import type { DrizzleDB } from '../../database/drizzle.types';
import { orders } from '../../database/schema';
import { RiskService } from './risk.service';

/**
 * The checkout gates never refuse an order, never withhold a payment method
 * and never cap how often anyone may buy. All they do is ask a buyer repeating
 * inside the window who they are, in a fixed order: sign in, then confirm the
 * number the parcel is going to. These tests pin that order, and pin the cases
 * that must sail through with no steps at all.
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

  // The code proves a person is behind the account, once. It is not re-run
  // against the delivery number, so a gift to someone else's phone is not a
  // reason to ask an already-verified buyer all over again.
  it('asks nothing of a verified account ordering to a different number', async () => {
    const risk = await riskServiceFor({
      priorOrders: 1,
      account: { phone: '+8801711111111', phoneVerified: true },
    }).assessCheckout({ ...buyer, accountId: 'acct-1' });
    expect(risk.requirePhoneVerification).toBe(false);
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
