import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PaymentLinksService } from './payment-links.service';
import { CreatePaymentLinkDto } from './dto/payment-link.dto';
import type {
  GatewayPaymentRow,
  PaymentLinkCurrency,
} from '../../database/schema';

describe('Payment link currencies', () => {
  function harness(currency: PaymentLinkCurrency = 'USD') {
    const link = {
      id: 'link-1',
      token: 'ABCDEFGH234567',
      shopId: 'shop-1',
      title: 'Test link',
      amountCents: 1000,
      currency,
      status: 'active',
      createdAt: new Date(),
    };
    const values = jest
      .fn()
      .mockImplementation((input) => ({
        returning: async () => [{ ...link, ...input }],
      }));
    const set = jest
      .fn()
      .mockReturnValue({
        where: () => ({
          returning: async () => [{ id: 'link-1', shopId: 'shop-1' }],
        }),
      });
    const totals = [
      {
        currency: 'USD',
        collectedCents: '122000',
        collectedCount: '1',
        awaitingCents: '1000',
        awaitingCount: '1',
      },
      {
        currency: 'INR',
        collectedCents: '14000',
        collectedCount: '1',
        awaitingCents: '20000',
        awaitingCount: '2',
      },
      {
        currency: 'BDT',
        collectedCents: '1000',
        collectedCount: '1',
        awaitingCents: '5000',
        awaitingCount: '1',
      },
    ];
    const db = {
      insert: () => ({ values }),
      update: () => ({ set }),
      select: () => ({
        from: () => ({ where: () => ({ groupBy: async () => totals }) }),
      }),
      query: {
        paymentLinks: {
          findFirst: async () => link,
          findMany: async () => [link],
        },
      },
    };
    const open = jest
      .fn()
      .mockResolvedValue({ paymentUrl: 'https://example.com/pay' });
    const svc = new PaymentLinksService(
      db as never,
      {
        requireById: async () => ({
          id: 'shop-1',
          live: true,
          currency: 'BDT',
          supportEmail: 'shop@example.com',
        }),
      } as never,
      {
        byCode: async () =>
          new Map([
            [
              'card',
              {
                code: 'card',
                gateway: 'sslcommerz',
                enabled: true,
                feeBp: 300,
              },
            ],
          ]),
      } as never,
      { isConfigured: async () => true, open } as never,
      { get: () => undefined } as never,
      {} as never,
      { assertClean: async () => undefined } as never,
    );
    jest.spyOn(svc as any, 'closeIfCreditSpent').mockResolvedValue(undefined);
    return { svc, values, set, open };
  }

  it.each(['BDT', 'USD', 'INR'] as const)(
    'stores and returns %s on creation',
    async (currency) => {
      const { svc, values } = harness(currency);
      const result = await svc.create('shop-1', {
        title: 'Test link',
        amount: 10.25,
        currency,
      });
      expect(values).toHaveBeenCalledWith(
        expect.objectContaining({ amountCents: 1025, currency }),
      );
      expect(result).toMatchObject({ amount: 10.25, currency });
    },
  );

  it('defaults existing API clients to BDT and retains the BDT minimum', async () => {
    const { svc } = harness();
    expect(
      await svc.create('shop-1', { title: 'Test link', amount: 10 }),
    ).toMatchObject({ currency: 'BDT' });
    await expect(
      svc.create('shop-1', { title: 'Test link', amount: 9 }),
    ).rejects.toThrow('minimum BDT');
    expect(
      await svc.create('shop-1', {
        title: 'Test link',
        amount: 1,
        currency: 'USD',
      }),
    ).toMatchObject({ amount: 1, currency: 'USD' });
  });

  it.each(['USD', 'INR'] as const)(
    'uses the link currency %s on the buyer page and checkout',
    async (currency) => {
      const { svc, open } = harness(currency);
      expect(await svc.getPublic('ABCDEFGH234567')).toMatchObject({
        amount: 10,
        currency,
      });
      await svc.pay('ABCDEFGH234567', { name: 'Buyer', phone: '01700000000' });
      expect(open).toHaveBeenCalledWith(
        expect.objectContaining({ amountCents: 1000, currency }),
      );
    },
  );

  it('stores the captured BDT amount separately when a foreign link is paid', async () => {
    const { svc, set } = harness();
    await svc.settlePaid(
      {
        paymentLinkId: 'link-1',
        amountCents: 1000,
        currency: 'USD',
      } as GatewayPaymentRow,
      { gatewayTxnId: 'BANK-1', amountCents: 122000 },
    );
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'paid', settledAmountCents: 122000 }),
    );
    expect(set.mock.calls[0][0]).not.toHaveProperty('amountCents');
  });

  it('totals collected BDT and groups awaiting amounts by currency', async () => {
    const { svc } = harness();
    expect((await svc.listForShop('shop-1')).summary).toEqual({
      collected: 1370,
      collectedCount: 3,
      awaiting: 50,
      awaitingCount: 4,
      awaitingByCurrency: [
        { currency: 'BDT', amount: 50 },
        { currency: 'INR', amount: 200 },
        { currency: 'USD', amount: 10 },
      ],
    });
  });

  it.each(['EUR', 'usd', '', 123])(
    'rejects unsupported currency %j at the API boundary',
    async (currency) => {
      const errors = await validate(
        plainToInstance(CreatePaymentLinkDto, {
          title: 'Test link',
          amount: 10,
          currency,
        }),
      );
      expect(errors.some((e) => e.property === 'currency')).toBe(true);
    },
  );

  it.each([0, -1, 1.001, 500001])(
    'rejects invalid amount %s at the API boundary',
    async (amount) => {
      const errors = await validate(
        plainToInstance(CreatePaymentLinkDto, {
          title: 'Test link',
          amount,
          currency: 'USD',
        }),
      );
      expect(errors.some((e) => e.property === 'amount')).toBe(true);
    },
  );
});
