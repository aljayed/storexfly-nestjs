import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { KycStatus } from '../../../database/schema/enums';
import type { ShopRow } from '../../../database/schema';

/**
 * Owner-only KYC detail (returned by `GET`/`PATCH /shops/:id/kyc`). Carries the
 * uploaded trade licence, so it must never be served on public routes — the
 * public `ShopResponse` exposes only `kycStatus`.
 */
export class KycResponse {
  @ApiProperty({
    enum: ['unsubmitted', 'pending', 'verified', 'rejected'],
  })
  status!: KycStatus;

  @ApiPropertyOptional() legalName?: string;
  @ApiPropertyOptional() licenseNo?: string;
  @ApiPropertyOptional({ description: 'Trade licence document as a data URL' })
  document?: string;
  @ApiPropertyOptional() submittedAt?: string;

  static fromRow(row: ShopRow): KycResponse {
    return {
      status: row.kycStatus,
      legalName: row.kycLegalName ?? undefined,
      licenseNo: row.kycLicenseNo ?? undefined,
      document: row.kycDocument ?? undefined,
      submittedAt: row.kycSubmittedAt?.toISOString(),
    };
  }
}
