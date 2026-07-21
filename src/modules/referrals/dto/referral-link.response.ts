import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { CouponRow, ReferralLinkRow } from '../../../database/schema';

class ReferralCouponView {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'HOOMRI75' }) code!: string;
  @ApiProperty({ example: 75 }) percentOff!: number;
  @ApiProperty() active!: boolean;
}

/** Platform-admin console view of a referral link. */
export class ReferralLinkResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'rahim-fb' }) slug!: string;
  @ApiPropertyOptional() name?: string;
  @ApiProperty() active!: boolean;
  @ApiProperty() clicks!: number;
  @ApiProperty() signups!: number;
  @ApiProperty({ type: ReferralCouponView }) coupon!: ReferralCouponView;
  @ApiProperty() createdAt!: string;

  static fromRow(
    row: ReferralLinkRow & { coupon: CouponRow },
  ): ReferralLinkResponse {
    return {
      id: row.id,
      slug: row.slug,
      name: row.name ?? undefined,
      active: row.active,
      clicks: row.clicks,
      signups: row.signups,
      coupon: {
        id: row.coupon.id,
        code: row.coupon.code,
        percentOff: row.coupon.percentOff,
        active: row.coupon.active,
      },
      createdAt: row.createdAt.toISOString(),
    };
  }
}

/**
 * Public view of a referral link, quoted before anyone signs in. Amounts are
 * major units (৳). The discount covers only the first payment — the monthly
 * price afterwards is `monthlyFee`.
 */
export class ReferralResolveResponse {
  @ApiProperty({ example: 'rahim-fb' }) slug!: string;
  @ApiProperty({ example: 'HOOMRI75' }) code!: string;
  @ApiProperty({ example: 75 }) percentOff!: number;
  @ApiProperty({ example: 599 }) monthlyFee!: number;
  @ApiProperty({ example: 450 }) discount!: number;
  @ApiProperty({ example: 149 }) firstMonthTotal!: number;
  @ApiProperty({ example: 'BDT' }) currency!: string;
}
