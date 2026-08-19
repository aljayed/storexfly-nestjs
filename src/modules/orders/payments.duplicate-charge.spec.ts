import { PaymentsService } from './payments.service';
import type { GatewayPaymentRow } from '../../database/schema';

/**
 * The rule a real incident bought us: a gateway will settle the same checkout
 * session more than once. An order here was genuinely paid three times after
 * a broken redirect sent the buyer back to retry, and the code recorded one
 * charge and dropped two.
 *
 * So two things have to stay apart, and this pins both:
 *
 *   - every charge is recorded, including the second one against a session
 *     that is already paid - the money left someone's account either way;
 *   - the *effect* happens once, because it is claimed on the session, so an
 *     order is confirmed once however many times it was paid for.
 *
 * Getting either half wrong is expensive in opposite directions: drop the
 * charge and the buyer's money is invisible, apply it twice and the order's
 * books are wrong.
 */
describe('PaymentsService duplicate charges', () => {
  const SESSION: GatewayPaymentRow = {
    id: 'session-1',
    purpose: 'order',
    orderId: 'order-1',
    shopId: null,
    packCode: null,
    couponCode: null,
    discountCents: 0,
    refSlug: null,
    provider: 'sslcommerz',
    paymentId: '1007-6ECDD53A-MSYTTNNA',
    status: 'created',
    amountCents: 4_257_000,
    trxId: null,
    payerReference: '8801700000000',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  type Settle = (
    attempt: GatewayPaymentRow,
    charge: { gatewayTxnId: string; amountCents: number },
  ) => Promise<void>;

  interface Harness {
    settle: Settle;
    inserted: { provider: string; gatewayTxnId: string }[];
    confirmGatewayPayment: jest.Mock;
  }

  /**
   * A fake just deep enough for `settle`: it records inserted transactions
   * (honouring the unique key the real table enforces) and lets the session
   * be claimed exactly once, which is what the guarded UPDATE does.
   */
  function harness(): Harness {
    const inserted: { provider: string; gatewayTxnId: string }[] = [];
    let sessionClaimed = false;

    const db = {
      insert: () => ({
        values: (row: { provider: string; gatewayTxnId: string }) => ({
          onConflictDoNothing: () => ({
            returning: () => {
              const clash = inserted.some(
                (r) =>
                  r.provider === row.provider &&
                  r.gatewayTxnId === row.gatewayTxnId,
              );
              if (clash) return Promise.resolve([]);
              inserted.push(row);
              return Promise.resolve([{ id: `txn-${inserted.length}` }]);
            },
          }),
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => ({
            returning: () => {
              if (sessionClaimed) return Promise.resolve([]);
              sessionClaimed = true;
              return Promise.resolve([{ id: SESSION.id }]);
            },
          }),
        }),
      }),
      query: {
        paymentTransactions: {
          findFirst: () => Promise.resolve({ id: 'txn-existing' }),
        },
      },
    };

    const confirmGatewayPayment = jest.fn().mockResolvedValue(null);
    const service = new PaymentsService(
      db as never,
      { confirmGatewayPayment } as never,
      { ownerIdForShop: jest.fn(), grantPurchasedCredit: jest.fn() } as never,
      {} as never,
      {} as never,
      { get: () => undefined } as never,
    );
    // `settle` is the seam these rules live behind; the public callbacks are
    // just the two ways a gateway reaches it.
    const settle = (service as unknown as { settle: Settle }).settle.bind(
      service,
    ) as Settle;
    return { settle, inserted, confirmGatewayPayment };
  }

  it('records a second charge on an already-paid session', async () => {
    const { settle, inserted } = harness();
    await settle(SESSION, { gatewayTxnId: 'BANK-1', amountCents: 4_257_000 });
    await settle(
      { ...SESSION, status: 'success' },
      { gatewayTxnId: 'BANK-2', amountCents: 4_257_000 },
    );
    expect(inserted.map((r) => r.gatewayTxnId)).toEqual(['BANK-1', 'BANK-2']);
  });

  it('confirms the order only once, however many times it was paid', async () => {
    const { settle, confirmGatewayPayment } = harness();
    await settle(SESSION, { gatewayTxnId: 'BANK-1', amountCents: 4_257_000 });
    await settle(
      { ...SESSION, status: 'success' },
      { gatewayTxnId: 'BANK-2', amountCents: 4_257_000 },
    );
    await settle(
      { ...SESSION, status: 'success' },
      { gatewayTxnId: 'BANK-3', amountCents: 4_257_000 },
    );
    expect(confirmGatewayPayment).toHaveBeenCalledTimes(1);
    expect(confirmGatewayPayment).toHaveBeenCalledWith('order-1');
  });

  // The redirect and the IPN both describe the first charge. That is one
  // payment told to us twice, not two payments - the unique key collapses it.
  it('collapses one charge reported by both the redirect and the IPN', async () => {
    const { settle, inserted, confirmGatewayPayment } = harness();
    await settle(SESSION, { gatewayTxnId: 'BANK-1', amountCents: 4_257_000 });
    await settle(
      { ...SESSION, status: 'success' },
      { gatewayTxnId: 'BANK-1', amountCents: 4_257_000 },
    );
    expect(inserted).toHaveLength(1);
    expect(confirmGatewayPayment).toHaveBeenCalledTimes(1);
  });
});
