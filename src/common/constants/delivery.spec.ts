import {
  canonicalDistrict,
  resolveDeliveryArea,
  sameDistrict,
  type ShopDeliveryPolicy,
} from './delivery';

const nationwideShop: ShopDeliveryPolicy = {
  deliveryCoverage: 'nationwide',
  deliveryCity: 'Dhaka',
  deliveryCityCents: 6000,
};
const cityShop: ShopDeliveryPolicy = {
  deliveryCoverage: 'city',
  deliveryCity: 'Chattogram',
  deliveryCityCents: 5000,
};
const follows = {
  deliveryCoverage: null,
  deliveryCity: null,
  deliveryCityCents: null,
};

describe('resolveDeliveryArea', () => {
  it('follows a nationwide shop', () => {
    expect(resolveDeliveryArea(follows, nationwideShop)).toEqual({
      coverage: 'nationwide',
    });
  });

  it("follows a city-only shop's city and rate", () => {
    expect(resolveDeliveryArea(follows, cityShop)).toEqual({
      coverage: 'city',
      city: 'Chattogram',
      cents: 5000,
    });
  });

  it("keeps an item's own rate, including free, inside the shop's city", () => {
    expect(
      resolveDeliveryArea({ ...follows, deliveryCityCents: 0 }, cityShop),
    ).toEqual({ coverage: 'city', city: 'Chattogram', cents: 0 });
  });

  it('lets one item of a nationwide shop go city-only in its own city', () => {
    expect(
      resolveDeliveryArea(
        {
          deliveryCoverage: 'city',
          deliveryCity: 'Sylhet',
          deliveryCityCents: null,
        },
        nationwideShop,
      ),
    ).toEqual({ coverage: 'city', city: 'Sylhet', cents: 6000 });
  });

  it('lets one item of a city-only shop go nationwide', () => {
    expect(
      resolveDeliveryArea(
        { ...follows, deliveryCoverage: 'nationwide' },
        cityShop,
      ),
    ).toEqual({ coverage: 'nationwide' });
  });

  it('never strands an item on a city-only setting with no city', () => {
    expect(
      resolveDeliveryArea(follows, { ...cityShop, deliveryCity: null }),
    ).toEqual({ coverage: 'nationwide' });
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
