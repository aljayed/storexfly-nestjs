import type { CouponRow } from '../../database/schema';
import { CouponsService } from './coupons.service';

/**
 * The operator's narrowing rules on a platform coupon: one seller only, some
 * packs only, first purchase only. Each is a reason to refuse, layered on top
 * of the rules every coupon already had.
 */
describe('CouponsService.check - targeting', () => {
  const SELLER = 'user-1';
  const pack100k = { code: 'credit-100k', priceCents: 189900 };
  const pack200k = { code: 'credit-200k', priceCents: 349900 };

  const baseCoupon: CouponRow = {
    id: 'c1',
    code: 'WELCOME',
    description: null,
    percentOff: 50,
    active: true,
    maxRedemptions: null,
    redemptions: 0,
    expiresAt: null,
    firstPurchaseOnly: false,
    userId: null,
    packCodes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  /**
   * A select chain that resolves to `rows` however far it is followed - the
   * service asks for the seller's ledger and their high-sales shops through
   * the same builder, told apart by whether it joins.
   */
  function chain(rows: unknown[]) {
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'innerJoin', 'where', 'groupBy', 'having']) {
      c[m] = () => c;
    }
    c.limit = () => Promise.resolve(rows);
    return c;
  }

  function setup(coupon: CouponRow, opts: { paidBefore?: boolean } = {}) {
    const db = {
      query: {
        coupons: { findFirst: jest.fn().mockResolvedValue(coupon) },
      },
      select: jest.fn(() => {
        const c = chain([]);
        // The ledger lookup never joins; the high-sales one does.
        const ledger = chain(opts.paidBefore ? [{ id: 'p1' }] : []);
        return {
          from: () => ({
            ...ledger,
            innerJoin: () => c,
          }),
        };
      }),
    };
    const billing = {
      allPacks: jest.fn().mockResolvedValue([
        { code: 'credit-100k', name: '৳1,00,000 in sales' },
        { code: 'credit-200k', name: '৳2,00,000 in sales' },
      ]),
    };
    return new CouponsService(db as never, billing as never);
  }

  it('leaves an unrestricted coupon open to anyone, on any pack', async () => {
    const check = await setup(baseCoupon).check('welcome', SELLER, pack200k);
    expect(check).toMatchObject({ ok: true, discountCents: 175000 });
  });

  it('refuses a personal coupon to anybody else', async () => {
    const svc = setup({ ...baseCoupon, userId: 'someone-else' });
    const check = await svc.check('WELCOME', SELLER, pack100k);
    expect(check).toMatchObject({ ok: false, reason: 'wrong_user' });
  });

  it('accepts a personal coupon from its owner', async () => {
    const svc = setup({ ...baseCoupon, userId: SELLER });
    expect((await svc.check('WELCOME', SELLER, pack100k)).ok).toBe(true);
  });

  it('refuses a pack the coupon is not for, and names the one it is', async () => {
    const svc = setup({ ...baseCoupon, packCodes: ['credit-200k'] });
    const check = await svc.check('WELCOME', SELLER, pack100k);
    expect(check).toMatchObject({
      ok: false,
      reason: 'wrong_pack',
      message: 'This coupon only works on the ৳2,00,000 in sales pack.',
    });
    expect((await svc.check('WELCOME', SELLER, pack200k)).ok).toBe(true);
  });

  it('refuses a first-purchase coupon to a seller who has paid before', async () => {
    const svc = setup(
      { ...baseCoupon, firstPurchaseOnly: true },
      { paidBefore: true },
    );
    const check = await svc.check('WELCOME', SELLER, pack100k);
    expect(check).toMatchObject({ ok: false, reason: 'not_first_purchase' });
  });

  it('accepts a first-purchase coupon from a seller with no payments', async () => {
    const svc = setup({ ...baseCoupon, firstPurchaseOnly: true });
    expect((await svc.check('WELCOME', SELLER, pack100k)).ok).toBe(true);
  });
});
