import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { ShopRow } from '../../../database/schema';
import type { TrustBadge } from '../../../common/constants/trust-badges';

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
  @ApiProperty({ enum: ['en', 'bn'], example: 'en' }) language!: string;
  @ApiProperty() brandId!: string;
  @ApiProperty({ example: '#e8943a' }) brand!: string;
  @ApiProperty({ example: '#fbeede' }) brandSoft!: string;
  @ApiProperty() ownerId!: string;
  @ApiProperty() live!: boolean;
  @ApiProperty({ enum: ['free', 'paid'] }) plan!: string;
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
  @ApiPropertyOptional({
    description: 'Product-page "why buy" badges; omitted when never customised',
  })
  trustBadges?: TrustBadge[];
  // Business-verification state only - the trade licence itself stays on the
  // owner-only KYC endpoint and is never exposed here.
  @ApiProperty({ enum: ['unsubmitted', 'pending', 'verified', 'rejected'] })
  kycStatus!: string;
  @ApiProperty() createdAt!: string;

  /**
   * AI auto-reply switch. Console-only - see `fromRowForConsole`. Absent from
   * every public payload on purpose: the agent answers as the shop's own
   * staff, and a storefront field announcing "this shop replies with a bot"
   * would tell every buyer exactly what the agent is built not to.
   */
  @ApiPropertyOptional({
    description: 'AI auto-reply in the inbox. Console responses only.',
  })
  botChatEnabled?: boolean;

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
      language: row.language,
      brandId: row.brandId,
      brand: row.brand,
      brandSoft: row.brandSoft,
      ownerId: row.ownerId,
      live: row.live,
      plan: row.plan,
      bannerImages: row.bannerImages ?? undefined,
      floatingImages: row.floatingImages ?? undefined,
      trustBadges: row.trustBadges ?? undefined,
      kycStatus: row.kycStatus,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** The console's view: everything public plus the seller-only settings. */
  static fromRowForConsole(row: ShopRow): ShopResponse {
    return { ...ShopResponse.fromRow(row), botChatEnabled: row.botChatEnabled };
  }
}
