import { ConflictException } from '@nestjs/common';
import type { DrizzleDB } from '../../database/drizzle.types';
import { ShopsService } from './shops.service';

/**
 * An operator can take a storefront down from the platform console, but only
 * one they have already emptied. One button that removes a shop and
 * everything in it is a button nobody has read the contents of.
 */
function harness(productCount: number) {
  const shop = { id: 'shop-1', name: 'Test Shop', handle: 'test-shop', ownerId: 'owner-1', currency: 'BDT' };
  const db = {
    query: {
      shops: { findFirst: jest.fn().mockResolvedValue(shop) },
      users: { findFirst: jest.fn().mockResolvedValue({ email: 'owner@example.com' }) },
    },
    select: jest.fn().mockReturnValue({
      from: () => ({ where: () => Promise.resolve([{ n: productCount }]) }),
    }),
    transaction: jest.fn(),
  };
  const service = new ShopsService(
    db as unknown as DrizzleDB,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, db };
}

describe('deleting a shop from the platform console', () => {
  it('refuses while the shop still lists products', async () => {
    const h = harness(3);
    await expect(h.service.deleteAsOperator('shop-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(h.service.deleteAsOperator('shop-1')).rejects.toThrow(
      /still lists 3 products/,
    );
    expect(h.db.transaction).not.toHaveBeenCalled();
  });

  it('says so in a way the console can act on', async () => {
    const h = harness(1);
    await h.service.deleteAsOperator('shop-1').catch((err: unknown) => {
      const body = (err as ConflictException).getResponse() as { error: string };
      expect(body.error).toBe('ShopNotEmpty');
    });
    expect.assertions(1);
  });
});
