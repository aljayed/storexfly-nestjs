import {
  canonicalDistrict,
  deliveryCentsTo,
  resolveDelivery,
  sameDistrict,
  type ShopDeliveryPolicy,
} from './delivery';

const chattogramShop: ShopDeliveryPolicy = {
  deliveryCoverage: 'nationwide',
  deliveryCity: 'Chattogram',
  deliveryInsideCents: 6000,
  deliveryOutsideCents: 13000,
};
const follows = {
  deliveryCoverage: null,
  deliveryDhakaCents: null,
  deliveryOutsideCents: null,
};

describe('resolveDelivery', () => {
  it("prices an item that follows its shop at the shop's rates", () => {
    expect(resolveDelivery(follows, chattogramShop)).toEqual({
      coverage: 'nationwide',
      city: 'Chattogram',
      insideCents: 6000,
      outsideCents: 13000,
    });
  });

  it('keeps each of an item’s own charges, free included, on its own', () => {
    const own = resolveDelivery(
      { ...follows, deliveryDhakaCents: 0 },
      chattogramShop,
    );
    expect(own.insideCents).toBe(0);
    expect(own.outsideCents).toBe(13000);
  });

  it('lets an item be city-only in a nationwide shop, and back', () => {
    expect(
      resolveDelivery({ ...follows, deliveryCoverage: 'city' }, chattogramShop)
        .coverage,
    ).toBe('city');
    expect(
      resolveDelivery(
        { ...follows, deliveryCoverage: 'nationwide' },
        { ...chattogramShop, deliveryCoverage: 'city' },
      ).coverage,
    ).toBe('nationwide');
  });
});

describe('deliveryCentsTo', () => {
  const placed = resolveDelivery(follows, chattogramShop);

  it("measures the zones from the shop's city, not from Dhaka", () => {
    expect(deliveryCentsTo(placed, 'chattogram')).toBe(6000);
    expect(deliveryCentsTo(placed, 'Dhaka')).toBe(13000);
  });

  it('refuses a city-only item anywhere but its city', () => {
    const local = { ...placed, coverage: 'city' as const };
    expect(deliveryCentsTo(local, 'Chattogram')).toBe(6000);
    expect(deliveryCentsTo(local, 'Dhaka')).toBeNull();
  });
});

describe('district names', () => {
  it('canonicalises case, spacing and apostrophes', () => {
    expect(canonicalDistrict('  dhaka ')).toBe('Dhaka');
    expect(canonicalDistrict('Coxs  bazar')).toBe("Cox's Bazar");
    expect(canonicalDistrict('Cox’s Bazar')).toBe("Cox's Bazar");
  });

  it('refuses anything that is not a district', () => {
    expect(canonicalDistrict('Gulshan')).toBeNull();
    expect(canonicalDistrict('')).toBeNull();
    expect(canonicalDistrict(null)).toBeNull();
  });

  it('matches a buyer district loosely', () => {
    expect(sameDistrict('chattogram', 'Chattogram')).toBe(true);
    expect(sameDistrict('Chattogram', 'Dhaka')).toBe(false);
  });
});
