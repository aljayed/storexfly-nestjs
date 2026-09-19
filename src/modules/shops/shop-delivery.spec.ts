import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ShopDeliveryService } from './shop-delivery.service';
import { DeliverySettingsDto } from './dto/delivery-settings.dto';
import { ShopResponse } from './dto/shop.response';

const pickup = { deliveryMode: 'manual' as const, pickupDistrict: 'Dhaka', pickupContactName: 'Seller', pickupPhone: '01712345678', pickupAddress: 'House 5, Road 3, Banani' };
function harness() {
  const settings = { activeCourier: jest.fn().mockResolvedValue({ provider: 'carrybee', config: {} }) };
  const courier = { cities: jest.fn().mockResolvedValue([{ id: 1 }]), zones: jest.fn().mockResolvedValue([{ id: 2 }]), areas: jest.fn().mockResolvedValue([{ id: 3 }]) };
  return { settings, courier, service: new ShopDeliveryService(settings as never, courier as never) };
}
describe('shop delivery preferences', () => {
  it('saves a complete manual location without a courier dependency', async () => {
    const h = harness(); await expect(h.service.validate(pickup)).resolves.toBeUndefined();
    expect(h.settings.activeCourier).not.toHaveBeenCalled();
  });
  it.each(['pickupPhone', 'pickupContactName', 'pickupDistrict', 'pickupAddress'])('requires %s', async field => {
    await expect(harness().service.validate({ ...pickup, [field]: '' })).rejects.toThrow('pickup');
  });
  it('validates the city/zone/area hierarchy against the provider', async () => {
    const h = harness(); const data = { ...pickup, deliveryMode: 'carrybee' as const, pickupCityId: 1, pickupZoneId: 2, pickupAreaId: 3 };
    await expect(h.service.validate(data)).resolves.toBeUndefined();
    await expect(h.service.validate({ ...data, pickupAreaId: 999 })).rejects.toThrow('coverage');
    expect(h.courier.areas).toHaveBeenCalledWith({}, 1, 2);
  });
  it('rejects CarryBee selection when unavailable', async () => {
    const h = harness(); h.settings.activeCourier.mockResolvedValue(null);
    await expect(h.service.validate({ ...pickup, deliveryMode: 'carrybee', pickupCityId: 1, pickupZoneId: 2, pickupAreaId: 3 })).rejects.toThrow('unavailable');
  });
  it('rejects null or unsupported modes and invalid IDs at the API boundary', async () => {
    for (const input of [{ deliveryMode: null }, { deliveryMode: 'other' }, { pickupCityId: -1 }, { pickupAreaId: '3' }]) {
      expect((await validate(plainToInstance(DeliverySettingsDto, input))).length).toBeGreaterThan(0);
    }
  });
  it('keeps pickup details out of the public shop response', () => {
    const row = { ...pickup, createdAt: new Date() } as never;
    expect(ShopResponse.fromRow(row)).not.toHaveProperty('pickupAddress');
    expect(ShopResponse.fromRowForConsole(row)).toMatchObject(pickup);
  });
});
