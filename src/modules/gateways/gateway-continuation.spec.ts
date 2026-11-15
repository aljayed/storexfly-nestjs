import { GatewaySettingsService } from './gateway-settings.service';
import { BkashService } from './bkash.service';
import { SslcommerzService } from './sslcommerz.service';

function settings() {
  const row = {
    id: 'settings',
    bkashEnabled: true,
    bkashSandbox: true,
    bkashAppKey: 'key',
    bkashAppSecret: 'secret',
    bkashUsername: 'user',
    bkashPassword: 'password',
    sslcommerzEnabled: true,
    sslcommerzSandbox: true,
    sslcommerzStoreId: 'store',
    sslcommerzStorePassword: 'store-password',
  };
  const db = {
    query: { platformSettings: { findFirst: async () => ({ ...row }) } },
    update: () => ({
      set: (patch: object) => ({
        where: async () => {
          Object.assign(row, patch);
        },
      }),
    }),
  };
  return new GatewaySettingsService(db as never);
}
const payment = {
  amountCents: 10000,
  invoiceNumber: 'test-order',
  payerReference: '01712345678',
  callbackUrl: 'https://example.test/callback',
};

describe('gateway configuration changes', () => {
  afterEach(() => jest.restoreAllMocks());

  it('renews the bKash token when saved credentials change within the same environment', async () => {
    const config = settings(),
      bkash = new BkashService(config);
    let grants = 0;
    const fetch = jest
      .spyOn(global, 'fetch')
      .mockImplementation(async (url) => {
        const payload = String(url).endsWith('/token/grant')
          ? { id_token: `token-${++grants}`, expires_in: '3600' }
          : { paymentID: 'payment-1', bkashURL: 'https://example.test/pay' };
        return new Response(JSON.stringify(payload), { status: 200 });
      });
    await bkash.createPayment(payment);
    await bkash.createPayment(payment);
    expect(grants).toBe(1);
    await config.updateBkash({ appSecret: 'replacement-secret' });
    await bkash.createPayment(payment);
    expect(grants).toBe(2);
    expect(fetch).toHaveBeenLastCalledWith(
      expect.stringContaining('/create'),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'token-2' }),
      }),
    );
  });

  it('stops new bKash payments while completing a payment that was already approved', async () => {
    const config = settings(),
      bkash = new BkashService(config);
    await config.updateBkash({ enabled: false });
    const fetch = jest
      .spyOn(global, 'fetch')
      .mockImplementation(
        async (url) =>
          new Response(
            JSON.stringify(
              String(url).endsWith('/token/grant')
                ? { id_token: 'token', expires_in: '3600' }
                : {
                    statusCode: '0000',
                    transactionStatus: 'Completed',
                    trxID: 'trx',
                    amount: '100',
                  },
            ),
            { status: 200 },
          ),
      );
    expect(await bkash.isConfigured()).toBe(false);
    await expect(bkash.createPayment(payment)).rejects.toThrow('not available');
    expect(fetch).not.toHaveBeenCalled();
    expect(await bkash.executePayment('existing-payment')).toMatchObject({
      ok: true,
      trxId: 'trx',
      amountCents: 10000,
    });
  });

  it('stops new SSLCommerz sessions while validating and refunding earlier payments', async () => {
    const config = settings(),
      ssl = new SslcommerzService(config);
    await config.updateSslcommerz({ enabled: false });
    const fetch = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 'VALID',
            amount: '100',
            currency: 'BDT',
            tran_id: 'existing-payment',
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            APIConnect: 'DONE',
            status: 'success',
            refund_ref_id: 'refund-1',
          }),
        ),
      );
    expect(await ssl.isConfigured()).toBe(false);
    await expect(ssl.createSession({} as never)).rejects.toThrow(
      'not available',
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(await ssl.validate('existing-val')).toMatchObject({
      ok: true,
      amountCents: 10000,
    });
    expect(
      await ssl.refund({
        bankTranId: 'bank-1',
        refundTransId: 'refund-1',
        amountCents: 10000,
        remarks: 'Returned',
      }),
    ).toMatchObject({ status: 'success', refundRefId: 'refund-1' });
  });
});
