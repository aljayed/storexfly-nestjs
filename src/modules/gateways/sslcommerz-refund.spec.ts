import { SslcommerzService } from './sslcommerz.service';
import type { GatewaySettingsService } from './gateway-settings.service';

/**
 * Reading a refund response wrong is expensive in both directions: treat a
 * refusal as success and a buyer is never paid back while the order says they
 * were; treat an acceptance as a failure and a retry pays them twice.
 *
 * So these pin the mapping from what SSLCommerz actually returns to what the
 * rest of the app acts on - in particular that only 'success' and 'processing'
 * count as filed, and that an unreachable gateway is never confused with a
 * refusal, because one is retried and the other is not.
 */
describe('SslcommerzService.refund', () => {
  const config = { storeId: 'teststore', storePassword: 'qwerty', sandbox: true };

  function service() {
    const settings = {
      sslcommerzConfig: () => Promise.resolve(config),
    } as unknown as GatewaySettingsService;
    const svc = new SslcommerzService(settings);
    // The logger is noise here, and an expected error path logs on purpose.
    jest.spyOn(svc['logger'], 'error').mockImplementation(() => undefined);
    jest.spyOn(svc['logger'], 'warn').mockImplementation(() => undefined);
    return svc;
  }

  const input = {
    bankTranId: 'BANK123',
    refundTransId: 'rf_abc',
    amountCents: 150000,
    remarks: 'Order cancelled automatically',
  };

  function mockJson(body: unknown, ok = true) {
    global.fetch = jest.fn().mockResolvedValue({
      ok,
      status: ok ? 200 : 500,
      json: () => Promise.resolve(body),
    }) as unknown as typeof fetch;
  }

  afterEach(() => jest.restoreAllMocks());

  it('treats an accepted refund as filed and keeps the gateway reference', async () => {
    mockJson({ APIConnect: 'DONE', status: 'success', refund_ref_id: 'REF9' });
    const out = await service().refund(input);
    expect(out.status).toBe('success');
    expect(out.refundRefId).toBe('REF9');
  });

  it('treats an already-underway refund as filed, not as an error', async () => {
    // What a safe retry of the same refund_trans_id gets back.
    mockJson({ APIConnect: 'DONE', status: 'processing', refund_ref_id: 'REF9' });
    expect((await service().refund(input)).status).toBe('processing');
  });

  it('reports a refusal as failed and carries the reason', async () => {
    mockJson({ APIConnect: 'DONE', status: 'failed', errorReason: 'Insufficient balance' });
    const out = await service().refund(input);
    expect(out.status).toBe('failed');
    expect(out.reason).toBe('Insufficient balance');
  });

  it('does not read an unreachable gateway as a refusal', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ETIMEDOUT')) as unknown as typeof fetch;
    // 'unreachable' is retried; 'failed' is not. Confusing them either strands
    // the buyer's money or files the refund twice.
    expect((await service().refund(input)).status).toBe('unreachable');
  });

  it('does not read an HTTP error as a refusal either', async () => {
    mockJson({}, false);
    expect((await service().refund(input)).status).toBe('unreachable');
  });

  it('sends the amount in taka, not paisa, with the mandatory fields', async () => {
    mockJson({ APIConnect: 'DONE', status: 'success' });
    await service().refund(input);
    const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    const q = new URL(url).searchParams;
    expect(q.get('refund_amount')).toBe('1500.00');
    expect(q.get('bank_tran_id')).toBe('BANK123');
    expect(q.get('refund_trans_id')).toBe('rf_abc');
    expect(q.get('refund_remarks')).toBe('Order cancelled automatically');
    expect(q.get('store_id')).toBe('teststore');
  });

  it('never sends a refund_trans_id past the gateway 30-char limit', async () => {
    mockJson({ APIConnect: 'DONE', status: 'success' });
    await service().refund({ ...input, refundTransId: 'x'.repeat(60) });
    const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(new URL(url).searchParams.get('refund_trans_id')!.length).toBe(30);
  });
});

describe('SslcommerzService.refundStatus', () => {
  function service() {
    const settings = {
      sslcommerzConfig: () =>
        Promise.resolve({ storeId: 's', storePassword: 'p', sandbox: true }),
    } as unknown as GatewaySettingsService;
    const svc = new SslcommerzService(settings);
    jest.spyOn(svc['logger'], 'error').mockImplementation(() => undefined);
    return svc;
  }

  function mockJson(body: unknown) {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    }) as unknown as typeof fetch;
  }

  afterEach(() => jest.restoreAllMocks());

  it('only reports refunded when the buyer actually has the money', async () => {
    mockJson({ status: 'refunded', refunded_on: '2026-09-10 12:00:00' });
    const out = await service().refundStatus('REF9');
    expect(out.status).toBe('refunded');
    expect(out.refundedOn).toBe('2026-09-10 12:00:00');
  });

  it('keeps a still-processing refund open', async () => {
    mockJson({ status: 'processing' });
    expect((await service().refundStatus('REF9')).status).toBe('processing');
  });

  it('surfaces a cancelled refund rather than leaving it pending forever', async () => {
    mockJson({ status: 'cancelled', errorReason: 'Refund cancelled by bank' });
    expect((await service().refundStatus('REF9')).status).toBe('cancelled');
  });

  it('does not invent a conclusion from a status it does not know', async () => {
    mockJson({ status: 'something_new' });
    expect((await service().refundStatus('REF9')).status).toBe('unknown');
  });
});
