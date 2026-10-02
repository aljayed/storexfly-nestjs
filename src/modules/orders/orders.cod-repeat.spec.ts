import { ForbiddenException } from '@nestjs/common';
import { OrdersService } from './orders.service';

/*
 * A buyer may order the same item again inside the risk window, but only by
 * paying for it online: a repeat on cash on delivery is refused with
 * COD_UNAVAILABLE, and the preflight greys it out - for a signed-in caller
 * only, since telling a guest would reveal what any typed-in number ordered.
 */
type Stubbed = {
  checkout(dto: object, caller: object): Promise<unknown>;
  preflight(dto: object, caller: object): Promise<{ codAvailable: boolean }>;
};

/** Stops checkout at the first identity gate, past the COD rule. */
class ReachedRiskGate extends Error {}

function makeService(clash: string | null) {
  const orderedRecently = jest.fn().mockResolvedValue(clash);
  const service = Object.assign(Object.create(OrdersService.prototype), {
    db: {},
    orderedRecently,
    checkoutProductIds: jest.fn().mockResolvedValue(['p1']),
    assertGatewayAvailable: jest.fn().mockResolvedValue(undefined),
    shopRequiresLogin: jest.fn().mockResolvedValue(false),
    paymentMethods: {
      findEnabledByCode: jest.fn(async (code: string) => ({
        code,
        kind: code === 'cod' ? 'cod' : 'card',
        gateway: code === 'cod' ? 'none' : 'sslcommerz',
      })),
    },
    risk: {
      assessCheckout: jest.fn(() => {
        throw new ReachedRiskGate();
      }),
    },
    phoneProof: { canDeliver: true },
  }) as Stubbed;
  return { service, orderedRecently };
}

const order = (paymentMethod: string, paymentPlan?: string) => ({
  shopId: 's1',
  productId: 'p1',
  qty: 1,
  contact: { name: 'Arif', phone: '+8801712345678' },
  address: { line: 'House 1, Road 2, Dhanmondi', area: 'Dhaka' },
  paymentMethod,
  paymentPlan,
});
const guest = { ip: null, device: null, accountId: null };
const member = { ip: null, device: null, accountId: 'u1' };

describe('cash on delivery for a repeat order', () => {
  it('refuses a repeat on cash on delivery with COD_UNAVAILABLE', async () => {
    const { service } = makeService('Mango Box');
    const attempt = service.checkout(order('cod'), guest);
    await expect(attempt).rejects.toBeInstanceOf(ForbiddenException);
    await expect(attempt).rejects.toMatchObject({
      response: { code: 'COD_UNAVAILABLE' },
    });
  });

  it('lets the same repeat through when it is paid online', async () => {
    const { service, orderedRecently } = makeService('Mango Box');
    await expect(service.checkout(order('card'), guest)).rejects.toBeInstanceOf(
      ReachedRiskGate,
    );
    expect(orderedRecently).not.toHaveBeenCalled();
  });

  it('lets a 15% advance through - money moves before dispatch', async () => {
    const { service, orderedRecently } = makeService('Mango Box');
    await expect(
      service.checkout(order('card', 'cod_advance'), guest),
    ).rejects.toBeInstanceOf(ReachedRiskGate);
    expect(orderedRecently).not.toHaveBeenCalled();
  });

  it('lets a first order on cash on delivery through', async () => {
    const { service } = makeService(null);
    await expect(service.checkout(order('cod'), guest)).rejects.toBeInstanceOf(
      ReachedRiskGate,
    );
  });
});

describe('preflight codAvailable', () => {
  const ask = { shopId: 's1', phone: '+8801712345678', productIds: ['p1'] };

  beforeEach(() => jest.clearAllMocks());

  function preflightService(clash: string | null) {
    const made = makeService(clash);
    Object.assign(made.service, {
      risk: {
        assessCheckout: jest
          .fn()
          .mockResolvedValue({
            requireLogin: false,
            requirePhoneVerification: false,
          }),
      },
    });
    return made;
  }

  it('greys cash on delivery out for a signed-in buyer repeating an item', async () => {
    const { service } = preflightService('Mango Box');
    await expect(service.preflight(ask, member)).resolves.toMatchObject({
      codAvailable: false,
    });
  });

  it('never looks up order history for a guest', async () => {
    const { service, orderedRecently } = preflightService('Mango Box');
    await expect(service.preflight(ask, guest)).resolves.toMatchObject({
      codAvailable: true,
    });
    expect(orderedRecently).not.toHaveBeenCalled();
  });

  it('keeps it open when the buyer has not ordered the item', async () => {
    const { service } = preflightService(null);
    await expect(service.preflight(ask, member)).resolves.toMatchObject({
      codAvailable: true,
    });
  });
});
