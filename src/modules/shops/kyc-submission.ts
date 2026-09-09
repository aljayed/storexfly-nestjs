import { BadRequestException } from '@nestjs/common';
import type { ShopRow } from '../../database/schema';
import type { SubmitKycDto } from './dto/kyc.dto';

/** All identity details stay on owner/platform-only KYC responses. */
export function hasCompleteKyc(row: Partial<ShopRow>): boolean {
  return !!(
    row.kycDocument &&
    (row.kycLegalName?.trim().length ?? 0) >= 2 &&
    (row.kycOwnerLegalName?.trim().length ?? 0) >= 2 &&
    (row.kycBusinessAddress?.trim().length ?? 0) >= 10 &&
    row.kycLicenseNo?.trim()
  );
}

export function kycSubmissionPatch(
  dto?: SubmitKycDto,
  current?: Partial<ShopRow>,
): Partial<ShopRow> {
  if (!dto) return {};
  const patch: Partial<ShopRow> = {};
  const fields = {
    legalName: 'kycLegalName',
    ownerLegalName: 'kycOwnerLegalName',
    businessAddress: 'kycBusinessAddress',
    licenseNo: 'kycLicenseNo',
    document: 'kycDocument',
  } as const;
  for (const [input, column] of Object.entries(fields)) {
    const value = dto[input as keyof typeof fields];
    if (value !== undefined) patch[column] = value?.trim() || null;
  }
  if (!Object.keys(patch).length) return {};
  const next = { ...current, ...patch };
  // Onboarding submits a complete application or omits KYC altogether.
  // Existing shops may still save text drafts before attaching a document.
  if (
    (!current || current.kycDocument || next.kycDocument) &&
    !hasCompleteKyc(next)
  ) {
    throw new BadRequestException({
      error: 'IncompleteKyc',
      message:
        'Add the owner name, registered business name, registered address, licence number and trade licence before submitting for review.',
    });
  }
  const changed = Object.entries(patch).some(
    ([column, value]) => value !== (current?.[column as keyof ShopRow] ?? null),
  );
  if (!changed && current?.kycStatus !== 'rejected') return {};
  // Editing approved identity details needs review just like replacing a scan.
  if (hasCompleteKyc(next) && (changed || current?.kycStatus === 'rejected')) {
    patch.kycStatus = 'pending';
    patch.kycSubmittedAt = new Date();
    patch.kycReviewNote = null;
  }
  return patch;
}
