import { Logger } from '@nestjs/common';
import { CarrybeeBookingUncertain, CarrybeeService } from './carrybee.service';
const config = { clientId: 'test', clientSecret: 'test', clientContext: 'test', sandbox: true };
const parcel = { storeId: 'pickup-1', merchantOrderId: 'order-1', recipientName: 'Buyer', recipientPhone: '+8801712345678', recipientAddress: 'House 5, Road 2, Dhaka', cityId: 1, zoneId: 2, itemQuantity: 1, codAmountCents: 50000 };
describe('CarryBee booking outcomes', () => {
  afterEach(() => jest.restoreAllMocks());
  it('sends a parcel on the configured sandbox account', async () => {
    const request = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: { order: { consignment_id: 'CB-1', delivery_fee: '70' } } }), { status: 200 }));
    expect(await new CarrybeeService().createOrder(config, parcel)).toMatchObject({ consignmentId: 'CB-1', deliveryFeeCents: 7000 });
    expect(request).toHaveBeenCalledWith('https://sandbox.carrybee.com/api/v2/orders', expect.objectContaining({ method: 'POST', body: expect.stringContaining('"collectable_amount":500') }));
  });
  it('returns a clear retryable error for a definite provider rejection', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: true, message: 'Bad recipient' }), { status: 422 }));
    await expect(new CarrybeeService().createOrder(config, parcel)).rejects.toThrow('Failed to create parcel in CarryBee');
  });
  it.each(['network', 'server', 'malformed'])('does not treat %s as proof that no parcel exists', async kind => {
    const request = jest.spyOn(global, 'fetch');
    if (kind === 'network') request.mockRejectedValue(new Error('Connection reset'));
    else request.mockResolvedValue(new Response('{}', { status: kind === 'server' ? 503 : 200 }));
    await expect(new CarrybeeService().createOrder(config, parcel)).rejects.toBeInstanceOf(CarrybeeBookingUncertain);
  });
});
