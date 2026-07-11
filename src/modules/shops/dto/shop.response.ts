import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { ShopRow } from '../../../database/schema';

/** Public-facing shop shape (the `Shop` interface from the design handoff). */
export class ShopResponse {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() handle!: string;
  @ApiPropertyOptional() tagline?: string;
  @ApiPropertyOptional() supportEmail?: string;
  @ApiPropertyOptional() supportPhone?: string;
  @ApiProperty() cat!: string;
  @ApiProperty({ example: 'BDT' }) currency!: string;
  @ApiProperty() brandId!: string;
  @ApiProperty({ example: '#e8943a' }) brand!: string;
  @ApiProperty({ example: '#fbeede' }) brandSoft!: string;
  @ApiProperty() ownerId!: string;
  @ApiProperty() live!: boolean;
  @ApiPropertyOptional({
    type: [String],
    description: 'Storefront hero banner images (data URLs), in display order',
  })
  bannerImages?: string[];
  @ApiPropertyOptional({
    type: [String],
    description: 'Decorative images floating over the hero (data URLs)',
  })
  floatingImages?: string[];
  // Business-verification state only — the trade licence itself stays on the
  // owner-only KYC endpoint and is never exposed here.
  @ApiProperty({ enum: ['unsubmitted', 'pending', 'verified', 'rejected'] })
  kycStatus!: string;
  @ApiProperty() createdAt!: string;

  static fromRow(row: ShopRow): ShopResponse {
    return {
      id: row.id,
      name: row.name,
      handle: row.handle,
      tagline: row.tagline ?? undefined,
      supportEmail: row.supportEmail ?? undefined,
      supportPhone: row.supportPhone ?? undefined,
      cat: row.cat,
      currency: row.currency,
      brandId: row.brandId,
      brand: row.brand,
      brandSoft: row.brandSoft,
      ownerId: row.ownerId,
      live: row.live,
      bannerImages: row.bannerImages ?? undefined,
      floatingImages: row.floatingImages ?? undefined,
      kycStatus: row.kycStatus,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
