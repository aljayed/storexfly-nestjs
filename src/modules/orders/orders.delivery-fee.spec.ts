import { BadRequestException } from '@nestjs/common';
import { OrdersService } from './orders.service';
import type { ShopDeliveryPolicy } from '../../common/constants/delivery';

/*
 * The parcel's delivery charge, priced the way checkout prices it: zones are
 * measured from the shop's own city, items without a charge of their own
 * follow the shop, one parcel pays the highest fee, and a city-only item
 * refuses any other district.
 */
type Priced = { deliveryCents: number; label: string };
const service = Object.create(OrdersService.prototype) as {
  deliveryFee(
    dto: { address: { area: string } },
    items: object[],
    delivery: { shop: ShopDeliveryPolicy; strict: boolean },
  ): Priced;
};

const shop: ShopDeliveryPolicy = {
  deliveryCoverage: 'nationwide',
  deliveryCity: 'Chattogram',
  deliveryInsideCents: 7000,
  deliveryOutsideCents: 13000,
};
const follows = {
  name: 'Lychees',
  deliveryCoverage: null,
  deliveryDhakaCents: null,
  deliveryOutsideCents: null,
};
const price = (
  area: string,
  items: object[],
  policy = shop,
  strict = true,
): Priced =>
  service.deliveryFee({ address: { area } }, items, { shop: policy, strict });

describe('OrdersService.deliveryFee', () => {
  it("charges the shop's inside rate inside its own city", () => {
    expect(price('chattogram', [follows])).toEqual({
      deliveryCents: 7000,
      label: 'Inside Chattogram',
    });
  });

  it('charges the outside rate everywhere else - Dhaka included', () => {
    expect(price('Dhaka', [follows])).toEqual({
      deliveryCents: 13000,
      label: 'Outside Chattogram',
    });
  });

  it("uses an item's own charge over the shop's, and the highest in a parcel", () => {
    const pricey = { ...follows, name: 'Hamper', deliveryOutsideCents: 20000 };
    expect(price('Sylhet', [follows, pricey]).deliveryCents).toBe(20000);
  });

  it('keeps an item that is free everywhere free', () => {
    const free = { ...follows, deliveryDhakaCents: 0, deliveryOutsideCents: 0 };
    expect(price('Sylhet', [free]).deliveryCents).toBe(0);
  });

  it('refuses a city-only item outside the city, naming it', () => {
    const local = { ...follows, deliveryCoverage: 'city' };
    expect(() => price('Dhaka', [local])).toThrow(BadRequestException);
    expect(() => price('Dhaka', [local])).toThrow(/Lychees .*Chattogram/);
    expect(price('Chattogram', [local]).deliveryCents).toBe(7000);
  });

  it('treats a blank district as outside, and no place for a city-only item', () => {
    expect(price('', [follows]).deliveryCents).toBe(13000);
    const local = { ...follows, deliveryCoverage: 'city' };
    expect(() => price('', [local])).toThrow(BadRequestException);
    // A coupon preview may ask before any address exists.
    expect(price('', [local], shop, false).deliveryCents).toBe(0);
  });
});
