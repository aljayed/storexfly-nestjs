import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import type { DrizzleDB } from '../../database/drizzle.types';
import { AdminJwtAuthGuard } from '../../common/guards/admin-jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ShopScopeGuard } from '../../common/guards/shop-scope.guard';
import { ShopsController } from './shops.controller';
import { ShopsService } from './shops.service';
import type { CreateShopDto } from './dto/create-shop.dto';

const contact = {
  id: 'owner-test',
  email: 'owner@example.com',
  phone: '+8801712345678',
  emailVerified: true,
  phoneVerified: true,
};
const payload: CreateShopDto = {
  name: 'Test Shop',
  handle: 'test-shop',
  cat: 'Other',
  brandId: 'amber',
  supportEmail: 'support@example.com',
  supportPhone: '+8801712345678',
};
function harness() {
  const returning = jest
    .fn()
    .mockResolvedValue([
      { id: 'shop-test', ...payload, createdAt: new Date() },
    ]);
  const values = jest.fn().mockReturnValue({ returning });
  const tx = { insert: jest.fn().mockReturnValue({ values }) };
  const db = {
    query: {
      users: {
        findFirst: jest
          .fn()
          .mockResolvedValueOnce(contact)
          .mockResolvedValue(undefined),
      },
      shops: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(undefined),
      },
    },
    transaction: jest.fn(async (fn: (executor: unknown) => unknown) => fn(tx)),
  };
  const billing = { openForNewShop: jest.fn().mockResolvedValue({}) };
  const service = new ShopsService(
    db as unknown as DrizzleDB,
    billing as never,
    { assertClean: jest.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, db, billing, tx, values };
}

describe('shop onboarding persistence', () => {
  it('saves support contacts and opens billing inside the same transaction', async () => {
    const h = harness();
    await h.service.create(contact.id, payload);
    expect(h.values).toHaveBeenCalledWith(expect.objectContaining(payload));
    expect(h.billing.openForNewShop).toHaveBeenCalledWith(
      contact.id,
      'shop-test',
      h.tx,
    );
    expect(h.db.transaction).toHaveBeenCalledTimes(1);
  });
  it('does not report success when billing creation fails', async () => {
    const h = harness();
    h.billing.openForNewShop.mockRejectedValue(
      new Error('Billing insert failed'),
    );
    await expect(h.service.create(contact.id, payload)).rejects.toThrow(
      'Billing insert failed',
    );
    expect(h.db.transaction).toHaveBeenCalledTimes(1);
  });
  it.each(['emailVerified', 'phoneVerified'])(
    'requires %s before any write',
    async (flag) => {
      const h = harness();
      h.db.query.users.findFirst
        .mockReset()
        .mockResolvedValue({ ...contact, [flag]: false });
      await expect(h.service.create(contact.id, payload)).rejects.toThrow(
        ForbiddenException,
      );
      expect(h.db.transaction).not.toHaveBeenCalled();
    },
  );
  it('refuses incomplete KYC before inserting a shop', async () => {
    const h = harness();
    await expect(
      h.service.create(contact.id, {
        ...payload,
        kyc: { legalName: 'Incomplete' },
      }),
    ).rejects.toThrow();
    expect(h.db.transaction).not.toHaveBeenCalled();
  });
  it('never offers an existing shop handle, even to the same owner', async () => {
    const h = harness();
    h.db.query.shops.findFirst.mockResolvedValue({
      ownerId: contact.id,
    } as never);
    await expect(
      h.service.checkHandle(payload.handle, contact.id),
    ).resolves.toEqual({ available: false });
  });
  it('still offers the owner’s account username when no shop has it', async () => {
    const h = harness();
    await expect(
      h.service.checkHandle(payload.handle, contact.id),
    ).resolves.toEqual({ available: true });
  });
});

describe('private console KYC authorization', () => {
  const roles = new RolesGuard(new Reflector());
  const scope = new ShopScopeGuard();
  for (const action of ['consoleKyc', 'consoleSubmitKyc'] as const) {
    const handler = ShopsController.prototype[action];
    const context = (role: string, shopId = 'shop-test') =>
      ({
        getHandler: () => handler,
        getClass: () => ShopsController,
        switchToHttp: () => ({
          getRequest: () => ({
            user: { role, shopId: 'shop-test' },
            params: { shopId },
          }),
        }),
      }) as ExecutionContext;
    it(action + ' requires authentication, owner role and tenant scope', () => {
      expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toEqual([
        AdminJwtAuthGuard,
        ShopScopeGuard,
        RolesGuard,
      ]);
      expect(roles.canActivate(context('owner'))).toBe(true);
      expect(scope.canActivate(context('owner'))).toBe(true);
      for (const role of ['manager', 'editor', 'staff']) {
        expect(() => roles.canActivate(context(role))).toThrow(
          ForbiddenException,
        );
      }
      expect(() => scope.canActivate(context('owner', 'another-shop'))).toThrow(
        ForbiddenException,
      );
    });
  }
});
