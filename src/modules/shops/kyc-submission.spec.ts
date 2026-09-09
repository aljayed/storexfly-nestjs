import { BadRequestException, ValidationPipe } from '@nestjs/common';
import type { ShopRow } from '../../database/schema';
import { kycSubmissionPatch } from './kyc-submission';
import { SubmitKycDto } from './dto/kyc.dto';
import { CreateShopDto } from './dto/create-shop.dto';
import { ShopResponse } from './dto/shop.response';
import { KycResponse } from './dto/kyc.response';

const application: SubmitKycDto = {
  ownerLegalName: 'Test Owner',
  legalName: 'Test Trading',
  businessAddress: '12 Test Road, Dhaka 1212',
  licenseNo: 'TRADE/TEST/123',
  document: 'data:application/pdf;base64,JVBERg==',
};
const approved = {
  ...kycSubmissionPatch(application),
  kycStatus: 'verified',
  kycReviewNote: 'Reviewed',
  createdAt: new Date(),
} as ShopRow;

describe('business verification submission', () => {
  it('allows skipping onboarding verification without creating a pending request', () => {
    expect(kycSubmissionPatch()).toEqual({});
    expect(kycSubmissionPatch({})).toEqual({});
  });
  it('starts complete applications in manual review, never verified', () => {
    expect(kycSubmissionPatch(application)).toMatchObject({
      kycStatus: 'pending',
      kycOwnerLegalName: 'Test Owner',
      kycBusinessAddress: application.businessAddress,
      kycSubmittedAt: expect.any(Date),
      kycReviewNote: null,
    });
  });
  it.each(Object.keys(application))(
    'rejects onboarding with missing %s',
    (field) => {
      expect(() => kycSubmissionPatch({ ...application, [field]: '' })).toThrow(
        BadRequestException,
      );
    },
  );
  it('permits text-only drafts for shops that have not attached a licence', () => {
    expect(
      kycSubmissionPatch(
        { legalName: ' Draft ' },
        { kycStatus: 'unsubmitted' },
      ),
    ).toEqual({ kycLegalName: 'Draft' });
  });
  it.each([
    'legalName',
    'ownerLegalName',
    'businessAddress',
    'licenseNo',
    'document',
  ] as const)('reopens review when an approved %s changes', (field) => {
    expect(
      kycSubmissionPatch({ [field]: application[field] + 'changed' }, approved),
    ).toMatchObject({ kycStatus: 'pending', kycReviewNote: null });
  });
  it('leaves a no-op update alone instead of overwriting a newer submission', () => {
    expect(kycSubmissionPatch(application, approved)).toEqual({});
  });
  it('lets a rejected application be resubmitted and clears reviewer feedback', () => {
    expect(
      kycSubmissionPatch(application, { ...approved, kycStatus: 'rejected' }),
    ).toMatchObject({ kycStatus: 'pending', kycReviewNote: null });
  });
  it.each(['', null])(
    'refuses removing an approved document using %s',
    (document) => {
      expect(() =>
        kycSubmissionPatch({ document } as SubmitKycDto, approved),
      ).toThrow(BadRequestException);
    },
  );
  it('keeps private business fields out of public and general-console shop responses', () => {
    const privateFields = [
      'ownerLegalName',
      'businessAddress',
      'document',
      'reviewNote',
      'kycOwnerLegalName',
      'kycBusinessAddress',
      'kycDocument',
      'kycReviewNote',
    ];
    for (const payload of [
      ShopResponse.fromRow(approved),
      ShopResponse.fromRowForConsole(approved),
    ]) {
      for (const key of privateFields) expect(payload).not.toHaveProperty(key);
    }
    expect(KycResponse.fromRow(approved)).toMatchObject({
      ownerLegalName: application.ownerLegalName,
      businessAddress: application.businessAddress,
      document: application.document,
      reviewNote: 'Reviewed',
    });
  });
});

describe('onboarding payload validation', () => {
  const pipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  const payload = {
    name: ' Test Shop ',
    handle: 'test-shop',
    cat: 'Other',
    brandId: 'amber',
    supportEmail: ' support@example.com ',
    supportPhone: '+8801712345678',
    kyc: application,
  };
  const validate = (value: object) =>
    pipe.transform(value, { type: 'body', metatype: CreateShopDto });
  it('accepts the complete wizard payload and trims support/name fields', async () => {
    await expect(validate(payload)).resolves.toMatchObject({
      name: 'Test Shop',
      supportEmail: 'support@example.com',
      kyc: application,
    });
  });
  it.each([
    { supportPhone: '01712345678' },
    { supportEmail: 'not-email' },
    { kyc: { ...application, status: 'verified' } },
    { kyc: { ...application, document: 'data:text/html;base64,PHNjcmlwdD4=' } },
    { kyc: { ...application, ownerLegalName: 'A'.repeat(161) } },
    { kyc: { ...application, businessAddress: 'A'.repeat(501) } },
  ])('rejects invalid or privileged fields: %j', async (override) => {
    await expect(validate({ ...payload, ...override })).rejects.toThrow(
      BadRequestException,
    );
  });
});
