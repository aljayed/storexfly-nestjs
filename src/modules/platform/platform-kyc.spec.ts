import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type { DrizzleDB } from '../../database/drizzle.types';
import type { ShopRow } from '../../database/schema';
import { NoticesService } from '../notices/notices.service';
import { kycSubmissionPatch } from '../shops/kyc-submission';
import { PlatformOverviewService } from './platform-overview.service';

const pending = {
  id: 'shop-test',
  ...kycSubmissionPatch({
    legalName: 'Test Business',
    ownerLegalName: 'Test Owner',
    businessAddress: '12 Example Road, Dhaka',
    licenseNo: 'TEST/123',
    document: 'data:application/pdf;base64,JVBERg==',
  }),
} as ShopRow;
const stamp = pending.kycSubmittedAt!.toISOString();

function harness(row: Partial<ShopRow> | undefined = pending) {
  const returning = jest.fn().mockResolvedValue([{ id: pending.id }]);
  const where = jest.fn().mockReturnValue({ returning });
  const set = jest.fn().mockReturnValue({ where });
  const update = jest.fn().mockReturnValue({ set });
  const db = {
    query: { shops: { findFirst: jest.fn().mockResolvedValue(row) } },
    update,
  };
  const service = new PlatformOverviewService(
    db as unknown as DrizzleDB,
    {} as NoticesService,
  );
  jest
    .spyOn(service, 'getKyc')
    .mockResolvedValue({ shopId: pending.id } as never);
  return { service, update, set, where, returning };
}

describe('platform business verification decisions', () => {
  it('approves only the complete pending submission the reviewer opened', async () => {
    const h = harness();
    await h.service.decideKyc(pending.id, 'verified', undefined, stamp);
    expect(h.set).toHaveBeenCalledWith({
      kycStatus: 'verified',
      kycReviewNote: null,
    });
    expect(h.where).toHaveBeenCalledTimes(1);
  });
  it('stores a rejection reason for the seller', async () => {
    const h = harness();
    await h.service.decideKyc(
      pending.id,
      'rejected',
      ' Please upload a clear scan. ',
      stamp,
    );
    expect(h.set).toHaveBeenCalledWith({
      kycStatus: 'rejected',
      kycReviewNote: 'Please upload a clear scan.',
    });
  });
  it.each(['', '   ', undefined])(
    'rejects a rejection without useful feedback (%s)',
    async (note) => {
      const h = harness();
      await expect(
        h.service.decideKyc(pending.id, 'rejected', note, stamp),
      ).rejects.toThrow(BadRequestException);
      expect(h.update).not.toHaveBeenCalled();
    },
  );
  it.each(['unsubmitted', 'verified', 'rejected'] as const)(
    'does not re-decide %s records',
    async (status) => {
      const h = harness({ ...pending, kycStatus: status });
      await expect(
        h.service.decideKyc(pending.id, 'verified', undefined, stamp),
      ).rejects.toThrow(ConflictException);
      expect(h.update).not.toHaveBeenCalled();
    },
  );
  it.each([undefined, '2020-01-01T00:00:00.000Z'])(
    'refuses a missing or stale review timestamp (%s)',
    async (stamp) => {
      const h = harness();
      await expect(
        h.service.decideKyc(pending.id, 'verified', undefined, stamp),
      ).rejects.toThrow(ConflictException);
      expect(h.update).not.toHaveBeenCalled();
    },
  );
  it('requires legacy applications to supply missing details before approval', async () => {
    const h = harness({
      ...pending,
      kycOwnerLegalName: null,
      kycBusinessAddress: null,
    });
    await expect(
      h.service.decideKyc(pending.id, 'verified', undefined, stamp),
    ).rejects.toThrow(BadRequestException);
  });
  it('rejects a decision if the submission changed during the write', async () => {
    const h = harness();
    h.returning.mockResolvedValue([]);
    await expect(
      h.service.decideKyc(pending.id, 'verified', undefined, stamp),
    ).rejects.toThrow(ConflictException);
    expect(h.service.getKyc).not.toHaveBeenCalled();
  });
  it('reports a missing shop', async () => {
    const h = harness();
    // Return no row rather than the harness default.
    (
      h.service as unknown as {
        db: { query: { shops: { findFirst: jest.Mock } } };
      }
    ).db.query.shops.findFirst.mockResolvedValue(undefined);
    await expect(
      h.service.decideKyc('missing', 'verified', undefined, stamp),
    ).rejects.toThrow(NotFoundException);
  });
});
