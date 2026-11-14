import { SslcommerzService } from './sslcommerz.service';
import { GatewayCheckoutService } from './gateway-checkout.service';

describe('SSLCommerz currency transport', () => {
  const svc = new SslcommerzService({
    sslcommerzConfig: async () => ({
      storeId: 'test',
      storePassword: 'test',
      sandbox: true,
    }),
  } as never);
  afterEach(() => jest.restoreAllMocks());

  it.each([undefined, 'BDT', 'USD', 'INR', 'EUR', 'SAR'] as const)(
    'sends %s without conversion and restricts only foreign currency to cards',
    async (currency) => {
      const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          status: 'SUCCESS',
          GatewayPageURL: 'https://sandbox.sslcommerz.com/pay',
        }),
      } as Response);
      await svc.createSession({
        amountCents: 1234,
        currency,
        tranId: 'PAY-TEST',
        productName: 'Test',
        customer: {
          name: 'Buyer',
          email: 'buyer@example.com',
          phone: '01700000000',
          address: '',
          city: '',
          postcode: '',
        },
        successUrl: '',
        failUrl: '',
        cancelUrl: '',
        ipnUrl: '',
      });
      const body = new URLSearchParams(
        fetchMock.mock.calls[0][1]?.body as string,
      );
      expect(body.get('currency')).toBe(currency ?? 'BDT');
      expect(body.get('total_amount')).toBe('12.34');
      expect(body.get('multi_card_name')).toBe(
        currency && currency !== 'BDT' ? 'mastercard,visacard,amexcard' : null,
      );
    },
  );

  it('keeps original and settled amounts separate in validator responses', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'VALID',
        amount: '1220.00',
        currency: 'BDT',
        currency_type: 'USD',
        currency_amount: '10.00',
      }),
    } as Response);
    expect(await svc.validate('VAL-1')).toMatchObject({
      ok: true,
      amountCents: 122000,
      currency: 'BDT',
      originalCurrency: 'USD',
      originalAmountCents: 1000,
    });
  });

  it('does not accept partially numeric amounts', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'VALID',
        amount: '1220oops',
        currency_amount: '10oops',
      }),
    } as Response);
    expect(await svc.validate('VAL-1')).toMatchObject({
      amountCents: undefined,
      originalAmountCents: undefined,
    });
  });

  it.each(['BDT', 'USD', 'INR', 'MYR', 'AUD'] as const)(
    'persists %s on the checkout attempt',
    async (currency) => {
      const values = jest.fn().mockReturnValue({ returning: async () => [{}] });
      const createSession = jest
        .fn()
        .mockResolvedValue({ gatewayUrl: 'https://example.com/pay' });
      const checkout = new GatewayCheckoutService(
        { insert: () => ({ values }) } as never,
        {} as never,
        { isConfigured: async () => true, createSession } as never,
        { get: () => undefined } as never,
      );
      await checkout.open({
        purpose: 'payment_link',
        gateway: 'sslcommerz',
        amountCents: 1234,
        currency,
        reference: 'PAY',
        entityId: 'link-1',
        productName: 'Test',
        customer: {
          name: 'Buyer',
          email: 'buyer@example.com',
          phone: '01700000000',
          address: '',
          city: '',
          postcode: '',
        },
      });
      expect(values).toHaveBeenCalledWith(
        expect.objectContaining({ currency, amountCents: 1234 }),
      );
      expect(createSession).toHaveBeenCalledWith(
        expect.objectContaining({ currency, amountCents: 1234 }),
      );
    },
  );
});
