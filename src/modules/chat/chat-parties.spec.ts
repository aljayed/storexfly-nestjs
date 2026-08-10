import { pairKeyFor, partiesOf, partyKey } from './chat-parties';

describe('chat parties', () => {
  it('builds the same key whichever party opens the thread', () => {
    const account = { kind: 'account' as const, id: 'account-id' };
    const shop = { kind: 'shop' as const, id: 'shop-id' };
    expect(pairKeyFor(account, shop)).toBe(pairKeyFor(shop, account));
    expect(pairKeyFor(account, shop)).toBe('account:account-id|shop:shop-id');
  });

  it('gives an owner both their account and shop party', () => {
    expect(
      partiesOf(
        {
          role: 'customer',
          id: 'owner',
          name: 'Owner',
          email: 'o@example.com',
        },
        { ownedShopIds: ['shop'] },
      ).map(partyKey),
    ).toEqual(['account:owner', 'shop:shop']);
  });

  it('keeps invited staff scoped to the shop', () => {
    expect(
      partiesOf({ role: 'seller', id: 'staff', shopId: 'shop', name: 'Staff' }),
    ).toEqual([{ kind: 'shop', id: 'shop' }]);
  });
});
