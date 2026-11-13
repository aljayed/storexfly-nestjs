import { PaymentsService } from './payments.service';
import type { GatewayPaymentRow } from '../../database/schema';
import type { SslcommerzValidation } from '../gateways/sslcommerz.service';

describe('SSLCommerz currency validation', () => {
  const attempt = {
    paymentId: 'PAY-TEST',
    status: 'created',
    purpose: 'payment_link',
    currency: 'USD',
    amountCents: 1000,
  } as GatewayPaymentRow;
  const valid: SslcommerzValidation = {
    ok: true,
    status: 'VALID',
    tranId: 'PAY-TEST',
    bankTranId: 'BANK-1',
    amountCents: 122000,
    currency: 'BDT',
    originalCurrency: 'USD',
    originalAmountCents: 1000,
  };

  function harness(validation: SslcommerzValidation) {
    const svc = new PaymentsService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { validate: jest.fn().mockResolvedValue(validation) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const settle = jest
      .spyOn(svc as any, 'settle')
      .mockResolvedValue(undefined);
    const fail = jest
      .spyOn(svc as any, 'failAttempt')
      .mockResolvedValue(undefined);
    jest.spyOn(svc['logger'], 'warn').mockImplementation(() => undefined);
    return { svc, settle, fail };
  }

  it.each(['USD', 'INR'])(
    'validates %s in original units and records BDT for refunds and payouts',
    async (currency) => {
      const { svc, settle } = harness({ ...valid, originalCurrency: currency });
      expect(
        await svc['settleSslcommerz']({ ...attempt, currency }, 'VAL-1'),
      ).toEqual({ status: 'success', trxId: 'BANK-1' });
      expect(settle).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          amountCents: 122000,
          currency: 'BDT',
        }),
      );
    },
  );

  it.each([
    { originalAmountCents: 999 },
    { originalAmountCents: undefined },
    { originalAmountCents: NaN },
    { originalCurrency: 'INR' },
    { originalCurrency: undefined },
    { amountCents: undefined },
    { amountCents: 0 },
    { amountCents: NaN },
    { currency: 'USD' },
    { currency: undefined },
    { tranId: 'OTHER' },
    { tranId: undefined },
  ])('rejects invalid foreign payment evidence: %j', async (override) => {
    const { svc, settle, fail } = harness({ ...valid, ...override });
    expect(await svc['settleSslcommerz'](attempt, 'VAL-1')).toEqual({
      status: 'failed',
    });
    expect(settle).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalled();
  });

  it('continues accepting BDT payments without optional original-currency fields', async () => {
    const { svc } = harness({
      ...valid,
      originalCurrency: undefined,
      originalAmountCents: undefined,
    });
    expect(
      await svc['settleSslcommerz'](
        { ...attempt, currency: 'BDT', amountCents: 122000 },
        'VAL-1',
      ),
    ).toEqual({ status: 'success', trxId: 'BANK-1' });
  });

  it('passes the captured BDT amount to the link settlement', async () => {
    const settlePaid = jest.fn().mockResolvedValue('paid');
    const svc = new PaymentsService(
      {
        update: () => ({
          set: () => ({ where: jest.fn().mockResolvedValue([]) }),
        }),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { settlePaid } as never,
      {} as never,
    );
    await svc['settlePaymentLink'](
      attempt,
      {
        gatewayTxnId: 'BANK-1',
        amountCents: 122000,
        currency: 'BDT',
      },
      'txn-1',
    );
    expect(settlePaid).toHaveBeenCalledWith(
      attempt,
      expect.objectContaining({ amountCents: 122000 }),
    );
  });
});
