import { ServiceUnavailableException } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { CarrybeeBookingUncertain } from '../gateways/carrybee.service';

function harness(mode: 'manual' | 'carrybee' = 'carrybee') {
  const row: any = { id: 'order-1', shopId: 'shop-1', reference: '#1001', status: 'Packed', deliveryMode: mode, courierBookingState: null,
    courierConsignmentId: null, placedAt: new Date(), customerName: 'Buyer', phone: '01712345678', email: 'buyer@example.com',
    address: { line: 'House 7, Road 3', area: 'Dhaka' }, qty: 2, pay: 'Due', totalCents: 150000, advanceCents: 0 };
  const writes: any[] = [];
  let failSave = false;
  const db = { query: { orders: { findFirst: jest.fn(async () => ({ ...row })) }, orderItems: { findMany: jest.fn().mockResolvedValue([]) } },
    update: () => ({ set: (patch: any) => ({ where: () => {
      const run = async () => {
        if (patch.courierBookingState === 'creating' && row.courierBookingState) return [];
        if (patch.courierConsignmentId && failSave) throw new Error('Database unavailable');
        writes.push(patch); Object.assign(row, patch); return [{ ...row }];
      };
      return { returning: run, then: (resolve: any, reject: any) => run().then(resolve, reject) };
    } }) }) };
  const courier = { resolveAddress: jest.fn().mockResolvedValue({ cityId: 1, zoneId: 2 }), createOrder: jest.fn().mockResolvedValue({ consignmentId: 'CB-123', deliveryFeeCents: 7000, codFeeCents: 1000 }) };
  const settings = { activeCourier: jest.fn().mockResolvedValue({ provider: 'carrybee', config: {} }), courierRequired: jest.fn().mockResolvedValue(true) };
  const service = Object.create(OrdersService.prototype) as OrdersService;
  Object.assign(service, { db, carrybee: courier, courierSettings: settings, courierStores: { resolve: jest.fn().mockResolvedValue('store-1') }, notifications: { orderEvent: jest.fn() } });
  return { service, row, writes, courier, settings, failSave: () => { failSave = true; } };
}
describe('CarryBee handover', () => {
  it('books from the shop pickup and commits the consignment and handover together', async () => {
    const h = harness(); const result = await h.service.updateStatus('shop-1', 'order-1', 'HandedOver');
    expect(h.courier.createOrder).toHaveBeenCalledWith({}, expect.objectContaining({ storeId: 'store-1', codAmountCents: 150000 }));
    expect(result).toMatchObject({ status: 'HandedOver', courierConsignmentId: 'CB-123' });
    expect(h.writes.find(p => p.status === 'HandedOver')).toMatchObject({ courierConsignmentId: 'CB-123', courierBookingState: null });
  });
  it('leaves the order packed on rejection and permits a corrected retry', async () => {
    const h = harness(); h.courier.createOrder.mockRejectedValueOnce(new ServiceUnavailableException('Rejected'));
    await expect(h.service.updateStatus('shop-1', 'order-1', 'HandedOver')).rejects.toThrow('Failed to create parcel in CarryBee');
    expect(h.row).toMatchObject({ status: 'Packed', courierConsignmentId: null, courierBookingState: null });
    await h.service.updateStatus('shop-1', 'order-1', 'HandedOver'); expect(h.row.status).toBe('HandedOver');
  });
  it('keeps uncertain requests packed and blocks duplicate creation', async () => {
    const h = harness(); h.courier.createOrder.mockRejectedValue(new CarrybeeBookingUncertain());
    await expect(h.service.updateStatus('shop-1', 'order-1', 'HandedOver')).rejects.toThrow('not confirmed');
    expect(h.row).toMatchObject({ status: 'Packed', courierBookingState: 'uncertain' });
    await expect(h.service.bookCourier('shop-1', 'order-1')).rejects.toThrow('already in progress');
    expect(h.courier.createOrder).toHaveBeenCalledTimes(1);
  });
  it('does not create a second parcel when persisting the first one fails', async () => {
    const h = harness(); h.failSave();
    await expect(h.service.updateStatus('shop-1', 'order-1', 'HandedOver')).rejects.toThrow('not confirmed');
    expect(h.row).toMatchObject({ status: 'Packed', courierBookingState: 'uncertain' });
    await expect(h.service.bookCourier('shop-1', 'order-1')).rejects.toThrow(); expect(h.courier.createOrder).toHaveBeenCalledTimes(1);
  });
  it('serializes simultaneous handover requests', async () => {
    const h = harness(); const results = await Promise.allSettled([h.service.bookCourier('shop-1', 'order-1'), h.service.bookCourier('shop-1', 'order-1')]);
    expect(h.courier.createOrder).toHaveBeenCalledTimes(1); expect(results.some(r => r.status === 'fulfilled')).toBe(true);
  });
  it('repeating a completed handover is idempotent', async () => {
    const h = harness(); await h.service.updateStatus('shop-1', 'order-1', 'HandedOver'); await h.service.updateStatus('shop-1', 'order-1', 'HandedOver');
    expect(h.courier.createOrder).toHaveBeenCalledTimes(1);
  });
  it('requires packing, a delivery address and any outstanding advance', async () => {
    for (const patch of [{ status: 'Confirmed' }, { address: {} }, { advanceCents: 1500, advancePaidAt: null }]) {
      const h = harness(); Object.assign(h.row, patch);
      await expect(h.service.updateStatus('shop-1', 'order-1', 'HandedOver')).rejects.toThrow(); expect(h.courier.createOrder).not.toHaveBeenCalled();
    }
  });
  it('collects only the remaining balance, or nothing for prepaid orders', async () => {
    for (const [patch, amount] of [[{ advanceCents: 15000, advancePaidAt: new Date() }, 135000], [{ pay: 'Paid' }, 0]] as const) {
      const h = harness(); Object.assign(h.row, patch); await h.service.updateStatus('shop-1', 'order-1', 'HandedOver');
      expect(h.courier.createOrder).toHaveBeenCalledWith({}, expect.objectContaining({ codAmountCents: amount }));
    }
  });
  it('uses manual delivery without calling a courier even when platform courier is required', async () => {
    const h = harness('manual'); await h.service.updateStatus('shop-1', 'order-1', 'HandedOver');
    expect(h.row.status).toBe('HandedOver'); expect(h.courier.createOrder).not.toHaveBeenCalled();
  });
  it('refuses to silently replace CarryBee with another platform courier', async () => {
    const h = harness(); h.settings.activeCourier.mockResolvedValue({ provider: 'pathao', config: {} });
    await expect(h.service.updateStatus('shop-1', 'order-1', 'HandedOver')).rejects.toThrow('unavailable'); expect(h.row.status).toBe('Packed');
  });
});
