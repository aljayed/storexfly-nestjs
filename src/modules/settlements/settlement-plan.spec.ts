import { planPayout } from './settlement-plan';

describe('allocating a payout transfer', () => {
  it('deducts debt across held cycles without making any cycle negative', () => {
    const p = planPayout({
      payoutCents: 100_000,
      carried: [{ period: '2026-11', cents: 150_000 }],
      outstandingCents: 180_000,
    });
    expect(p.transferCents).toBe(70_000);
    expect(p.carried[0]).toMatchObject({
      duesCents: 150_000,
      transferCents: 0,
    });
    expect(p.currentDuesCents).toBe(30_000);
    expect(p.currentTransferCents).toBe(70_000);
  });
  it('cannot use a previous transfer to clear a newly accumulated debt', () => {
    const p = planPayout({
      payoutCents: 1_100_000,
      previousPayoutCents: 1_000_000,
      previousDuesCents: 20_000,
      carried: [],
      outstandingCents: 200_000,
    });
    expect(p.availableCents).toBe(100_000);
    expect(p.deductionCents).toBe(100_000);
    expect(p.currentDuesCents).toBe(120_000);
    expect(p.transferCents).toBe(0);
  });
  it('does not transfer or deduct a paid cycle twice', () => {
    const p = planPayout({
      payoutCents: 1_000_000,
      previousPayoutCents: 1_000_000,
      previousDuesCents: 45_000,
      carried: [],
      outstandingCents: 100_000,
    });
    expect(p.availableCents).toBe(0);
    expect(p.deductionCents).toBe(0);
    expect(p.transferCents).toBe(0);
    expect(p.currentDuesCents).toBe(45_000);
  });
});
