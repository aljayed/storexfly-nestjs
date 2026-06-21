import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { KycStatus } from '../../../database/schema/enums';

/**
 * One shop's business-verification record as the platform operator sees it in
 * the KYC review queue: the shop + its owner's contact, the submitted licence
 * details, and the current review status. The (potentially large) document data
 * URL is omitted from the list and served only by the detail endpoint.
 */
export class PlatformKycResponse {
  @ApiProperty() shopId!: string;
  @ApiProperty({ example: 'Maya Kitchen' }) shopName!: string;
  @ApiProperty({ example: 'maya-kitchen' }) shopHandle!: string;
  @ApiProperty({ description: 'Shop owner display name' }) ownerName!: string;
  @ApiPropertyOptional({ description: 'Owner email (login)' }) ownerEmail?: string;
  @ApiPropertyOptional({ description: 'Owner phone, or shop support phone' })
  ownerPhone?: string;
  @ApiProperty({ enum: ['unsubmitted', 'pending', 'verified', 'rejected'] })
  status!: KycStatus;
  @ApiPropertyOptional({ description: 'Registered business name on the licence' })
  legalName?: string;
  @ApiPropertyOptional({ description: 'Trade licence number' }) licenseNo?: string;
  @ApiProperty({ description: 'A trade licence document is on file' })
  hasDocument!: boolean;
  @ApiPropertyOptional({ description: 'When the seller last submitted for review' })
  submittedAt?: string;
}

/** A single KYC record with the full trade-licence document (operator-only). */
export class PlatformKycDetailResponse extends PlatformKycResponse {
  @ApiPropertyOptional({ description: 'Trade licence document as a data URL' })
  document?: string;
}

/** Per-status tallies so the review UI can badge its tabs. */
export class PlatformKycCounts {
  @ApiProperty() pending!: number;
  @ApiProperty() verified!: number;
  @ApiProperty() rejected!: number;
}

/** Paginated KYC review queue. `total` counts the filtered set. */
export class PlatformKycListResponse {
  @ApiProperty({ type: [PlatformKycResponse] }) data!: PlatformKycResponse[];
  @ApiProperty({ type: PlatformKycCounts }) counts!: PlatformKycCounts;
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}
