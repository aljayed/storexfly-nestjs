import { ForbiddenException } from '@nestjs/common';
import { salesFeeBp } from '../../common/constants/billing';
import { orderDue } from '../service-fees/service-fee-core';
import { PaymentLinksService } from '../payment-links/payment-links.service';
import { PaymentMethodsService } from './payment-methods.service';
import {
  classify,
  emptyBuckets,
  payoutCents,
  snapshotCore,
} from './settlement-core';
import { shareOf } from './settlements.service';

const catalog = new Map([
  [
    'card',
    {
      code: 'card',
      title: 'Card',
      kind: 'card',
      gateway: 'sslcommerz',
      feeBp: 450,
    },
  ],
  [
    'cod',
    { code: 'cod', title: 'Cash', kind: 'cod', gateway: 'none', feeBp: 0 },
  ],
]) as never;

describe('trade fee policy', () => {
  it.each(['wholesale', 'reseller'])(
    'does not charge a %s sales commission on cash sales',
    (type) => {
      expect(salesFeeBp(type)).toBe(0);
      expect(
        orderDue(
          {
            id: 'o',
            totalCents: 1_000_000,
            advanceCents: 0,
            paymentMethod: 'cod',
            platformFeeBp: salesFeeBp(type),
            resellerShopId: null,
            resellerMarginCents: 0,
            duesPaidAt: null,
          },
          catalog,
        ).dueCents,
      ).toBe(0);
    },
  );
  it('keeps retail at 4.5% without charging processing twice', () => {
    expect(salesFeeBp('retail')).toBe(450);
    const cash = orderDue(
      {
        id: 'o',
        totalCents: 1_000_000,
        advanceCents: 0,
        paymentMethod: 'cod',
        platformFeeBp: 450,
        resellerShopId: null,
        resellerMarginCents: 0,
        duesPaidAt: null,
      },
      catalog,
    );
    expect(cash.feeCents).toBe(45_000);
    const online = emptyBuckets();
    online.byCode.set('card', 1_000_000);
    expect(payoutCents(classify(online, catalog))).toBe(955_000);
  });
  it('deducts 4.5% of the gross online receipt from the wholesaler and pays the full reseller margin', () => {
    const o = {
      shopId: 'supplier',
      resellerShopId: 'reseller',
      resellerMarginCents: 200_000,
      totalCents: 1_000_000,
      advanceCents: 0,
      paymentMethod: 'card',
      pay: 'Paid',
      deliveredAt: new Date('2026-11-20'),
      handedOverAt: null,
      deliveryMode: 'carrybee' as const,
      duesPaidAt: null,
    };
    const supplier = emptyBuckets(),
      reseller = emptyBuckets();
    shareOf(o, 'supplier', catalog)[0].add(supplier);
    shareOf(o, 'reseller', catalog)[0].add(reseller);
    const s = classify(supplier, catalog),
      r = classify(reseller, catalog);
    expect(s.online[0].feeCents).toBe(45_000);
    expect(s.resellerMarginCents).toBe(200_000);
    expect(payoutCents(s)).toBe(755_000);
    expect(r.online[0].feeCents).toBe(0);
    expect(payoutCents(r)).toBe(200_000);
    expect(payoutCents(s) + payoutCents(r) + s.online[0].feeCents).toBe(
      1_000_000,
    );
  });
  it('requires only the full reseller margin from wholesale cash collections', () => {
    const due = orderDue(
      {
        id: 'o',
        totalCents: 1_000_000,
        advanceCents: 0,
        paymentMethod: 'cod',
        platformFeeBp: 0,
        resellerShopId: 'reseller',
        resellerMarginCents: 200_000,
        duesPaidAt: null,
      },
      catalog,
    );
    expect(due).toMatchObject({
      feeCents: 0,
      marginCents: 200_000,
      dueCents: 200_000,
    });
  });
  it('keeps extreme markup processing shortfalls on the supplier without reducing or overfunding reseller earnings', () => {
    const o = {
      id: 'o',
      shopId: 'supplier',
      resellerShopId: 'reseller',
      resellerMarginCents: 990_000,
      totalCents: 1_000_000,
      advanceCents: 0,
      platformFeeBp: 0,
      paymentMethod: 'card',
      pay: 'Paid',
      deliveredAt: new Date('2026-11-20'),
      handedOverAt: null,
      deliveryMode: 'carrybee' as const,
      duesPaidAt: null,
    };
    const supplier = emptyBuckets(),
      reseller = emptyBuckets();
    shareOf(o, 'supplier', catalog)[0].add(supplier);
    shareOf(o, 'reseller', catalog)[0].add(reseller);
    const s = classify(supplier, catalog),
      r = classify(reseller, catalog);
    const due = orderDue(o, catalog);
    expect(s.processingShortfallCents).toBe(35_000);
    expect(due.dueCents).toBe(35_000);
    expect(payoutCents(s)).toBe(0);
    expect(payoutCents(r)).toBe(990_000);
    expect(
      payoutCents(s) + payoutCents(r) + s.online[0].feeCents - due.dueCents,
    ).toBe(1_000_000);
  });
  it('preserves the fee actually recorded on a paid historical snapshot', () => {
    const core = snapshotCore({
      ordersCount: 1,
      totalCents: 1_000_000,
      codCents: 0,
      otherCents: 0,
      mbankCents: 0,
      cardCents: 1_000_000,
      mbankFeeBp: 300,
      cardFeeBp: 350,
      breakdown: null,
    } as never);
    expect(core.online[0].feeBp).toBe(350);
    expect(payoutCents(core)).toBe(965_000);
  });
  it('quotes 4.5% for gateways and zero processing for direct collection even with old catalog rows', async () => {
    const rows = [
      {
        id: 'cod',
        code: 'cod',
        kind: 'cod',
        gateway: 'none',
        feeBp: 0,
        enabled: true,
      },
      {
        id: 'card',
        code: 'card',
        kind: 'card',
        gateway: 'sslcommerz',
        feeBp: 350,
        enabled: true,
      },
    ];
    const service = new PaymentMethodsService({
      query: { paymentMethods: { findMany: () => Promise.resolve(rows) } },
    } as never);
    expect((await service.byCode()).get('card')?.feeBp).toBe(450);
    expect(
      (await service.listEnabled()).find((m) => m.code === 'card')?.feePercent,
    ).toBe(4.5);
    expect(
      (await service.listEnabled()).find((m) => m.code === 'cod')?.feePercent,
    ).toBe(0);
  });
  it('blocks reseller payment-link creation at the service boundary', async () => {
    const service = new PaymentLinksService(
      {} as never,
      {
        requireById: () => Promise.resolve({ businessType: 'reseller' }),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await expect(
      service.create('reseller', {
        title: 'Link',
        amount: 2000,
        currency: 'BDT',
      } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
