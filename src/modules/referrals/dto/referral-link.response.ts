import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { CouponRow, ReferralLinkRow } from '../../../database/schema';
import { couponOff } from '../../coupons/coupon-discount';

class ReferralCouponView {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'HOOMRI75' }) code!: string;
  @ApiPropertyOptional({ example: 75 }) percentOff?: number;
  @ApiPropertyOptional({ example: 500, description: 'Fixed amount off, ৳' })
  amountOff?: number;
  @ApiProperty() active!: boolean;
  @ApiProperty() firstPurchaseOnly!: boolean;
  @ApiPropertyOptional({ example: ['credit-200k'] }) packCodes?: string[];
  @ApiPropertyOptional({
    description: 'Set when the coupon belongs to one seller',
  })
  personal?: boolean;
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
        ...couponOff(row.coupon),
        active: row.coupon.active,
        firstPurchaseOnly: row.coupon.firstPurchaseOnly,
        packCodes: row.coupon.packCodes?.length
          ? row.coupon.packCodes
          : undefined,
        personal: row.coupon.userId ? true : undefined,
      },
      createdAt: row.createdAt.toISOString(),
    };
  }
}

/**
 * Public view of a referral link, quoted before anyone signs in. Amounts are
 * major units (৳) and are quoted against the entry credit pack, which is what
 * "from ৳X" means on the landing page - or, when the coupon only works on
 * certain packs, against the cheapest of those. The storefront applies the
 * code to one purchase; packs bought afterwards cost the list price.
 */
export class ReferralResolveResponse {
  @ApiProperty({ example: 'rahim-fb' }) slug!: string;
  @ApiProperty({ example: 'HOOMRI75' }) code!: string;
  @ApiPropertyOptional({
    example: 75,
    description: 'Set on a percentage coupon',
  })
  percentOff?: number;
  @ApiPropertyOptional({
    example: 500,
    description: 'Set on a fixed-amount coupon, in ৳',
  })
  amountOff?: number;
  @ApiProperty({
    description: "Only good on a seller's first platform purchase",
  })
  firstPurchaseOnly!: boolean;
  @ApiPropertyOptional({
    example: ['credit-200k'],
    description: 'The packs on sale the code works on; absent = any pack',
  })
  packCodes?: string[];
  @ApiProperty({
    example: 'credit-100k',
    description: 'The pack the quote is based on',
  })
  packCode!: string;
  @ApiProperty({ example: '৳1,00,000 in sales' }) packName!: string;
  @ApiProperty({
    example: 1899,
    description: 'The pack the quote is based on, in ৳',
  })
  packPrice!: number;
  @ApiProperty({ example: 1425 }) discount!: number;
  @ApiProperty({
    example: 474,
    description: 'What that pack costs with the code applied, in ৳',
  })
  firstPaymentTotal!: number;
  @ApiProperty({ example: 'BDT' }) currency!: string;
}
