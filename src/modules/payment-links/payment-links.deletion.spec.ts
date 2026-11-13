import { ConflictException, NotFoundException } from '@nestjs/common';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { GatewayPaymentRow } from '../../database/schema';
import { PaymentLinksService } from './payment-links.service';

describe('Payment link deletion', () => {
  function harness(
    existing: Record<string, unknown> | undefined,
    updated = true,
  ) {
    const where = jest.fn().mockReturnValue({
      returning: async () =>
        updated ? [{ id: 'link-1', shopId: 'shop-1' }] : [],
    });
    const set = jest.fn().mockReturnValue({ where });
    const findFirst = jest.fn().mockResolvedValue(existing);
    const findMany = jest.fn().mockResolvedValue([]);
    const summaryWhere = jest.fn().mockReturnValue({ groupBy: async () => [] });
    const db = {
      update: jest.fn().mockReturnValue({ set }),
      delete: jest.fn(),
      query: { paymentLinks: { findFirst, findMany } },
      select: () => ({ from: () => ({ where: summaryWhere }) }),
    };
    const open = jest.fn();
    const svc = new PaymentLinksService(
      db as never,
      { requireById: async () => ({ id: 'shop-1', live: true }) } as never,
      { byCode: async () => new Map() } as never,
      { open } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    jest.spyOn(svc as any, 'closeIfCreditSpent').mockResolvedValue(undefined);
    return { svc, db, set, where, findFirst, findMany, summaryWhere, open };
  }

  const query = (sql: SQL) => new PgDialect().sqlToQuery(sql);

  it('cancels and hides the link atomically without deleting checkout references', async () => {
    const { svc, set, where, db } = harness({ status: 'active' });
    await svc.remove('shop-1', 'link-1');
    expect(set).toHaveBeenCalledWith({
      status: 'cancelled',
      deletedAt: expect.any(Date),
    });
    const predicate = query(where.mock.calls[0][0]);
    expect(predicate.params).toEqual([
      'link-1',
      'shop-1',
      'active',
      'cancelled',
    ]);
    expect(predicate.sql).toContain('"status" in');
    expect(predicate.sql).toContain('"deleted_at" is null');
    expect(db.delete).not.toHaveBeenCalled();
  });

  it.each(['paid', 'refunded'])(
    'refuses deletion when settlement has already set status=%s',
    async (status) => {
      const { svc } = harness({ status }, false);
      await expect(svc.remove('shop-1', 'link-1')).rejects.toBeInstanceOf(
        ConflictException,
      );
    },
  );

  it('returns not found for an unknown or another shop’s link', async () => {
    const { svc, findFirst } = harness(undefined, false);
    await expect(svc.remove('shop-1', 'link-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(query(findFirst.mock.calls[0][0].where).params).toEqual([
      'link-1',
      'shop-1',
    ]);
  });

  it('accepts a repeated deletion', async () => {
    const { svc } = harness(
      { status: 'cancelled', deletedAt: new Date() },
      false,
    );
    await expect(svc.remove('shop-1', 'link-1')).resolves.toBeUndefined();
  });

  it('excludes deleted links from both list rows and totals', async () => {
    const { svc, findMany, summaryWhere } = harness(undefined);
    await svc.listForShop('shop-1');
    for (const predicate of [
      findMany.mock.calls[0][0].where,
      summaryWhere.mock.calls[0][0],
    ]) {
      expect(query(predicate).sql).toContain('"deleted_at" is null');
      expect(query(predicate).params).toEqual(['shop-1']);
    }
  });

  it('disables the public page and new checkout for a deleted token', async () => {
    const { svc, open } = harness({
      status: 'cancelled',
      deletedAt: new Date(),
    });
    await expect(svc.getPublic('ABCDEFGH234567')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      svc.pay('ABCDEFGH234567', { name: 'Buyer', phone: '01700000000' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(open).not.toHaveBeenCalled();
  });

  it('cannot turn a deleted link back into a visible cancelled link', async () => {
    const { svc } = harness(
      { status: 'cancelled', deletedAt: new Date() },
      false,
    );
    await expect(svc.cancel('shop-1', 'link-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('restores a deleted link if a checkout already in progress pays later', async () => {
    const { svc, set } = harness({
      status: 'cancelled',
      deletedAt: new Date(),
    });
    const result = await svc.settlePaid(
      { paymentLinkId: 'link-1' } as GatewayPaymentRow,
      { gatewayTxnId: 'BANK-1', amountCents: 122000 },
    );
    expect(result).toBe('paid');
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'paid',
        deletedAt: null,
        settledAmountCents: 122000,
        trxId: 'BANK-1',
      }),
    );
  });
});
