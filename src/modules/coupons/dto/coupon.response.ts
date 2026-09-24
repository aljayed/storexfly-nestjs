import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { CouponRow } from '../../../database/schema';
import { couponOff } from '../coupon-discount';

/** The one seller a personal coupon belongs to. */
export class CouponUserView {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'Rafiq Ahmed' }) name!: string;
  @ApiPropertyOptional({ example: 'rafiq', nullable: true })
  handle!: string | null;
  @ApiProperty({ example: 'HM7K3PQR9X' }) publicId!: string;
}

/** Platform-admin console view of a coupon. */
export class CouponResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'HOOMRI75' }) code!: string;
  @ApiPropertyOptional() description?: string;
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
  @ApiProperty() active!: boolean;
  @ApiPropertyOptional() maxRedemptions?: number;
  @ApiProperty() redemptions!: number;
  @ApiPropertyOptional() expiresAt?: string;
  @ApiProperty({
    description: 'Only a seller with no platform payments yet may use it',
  })
  firstPurchaseOnly!: boolean;
  @ApiPropertyOptional({
    type: CouponUserView,
    description: 'The only seller who may use it; absent = any seller',
  })
  user?: CouponUserView;
  @ApiPropertyOptional({
    example: ['credit-200k'],
    description: 'The only packs it applies to; absent = any pack',
  })
  packCodes?: string[];
  @ApiProperty() createdAt!: string;

  static fromRow(
    row: CouponRow & { user?: CouponUserView | null },
  ): CouponResponse {
    return {
      id: row.id,
      code: row.code,
      description: row.description ?? undefined,
      ...couponOff(row),
      active: row.active,
      maxRedemptions: row.maxRedemptions ?? undefined,
      redemptions: row.redemptions,
      expiresAt: row.expiresAt?.toISOString(),
      firstPurchaseOnly: row.firstPurchaseOnly,
      user: row.user
        ? {
            id: row.user.id,
            name: row.user.name,
            handle: row.user.handle,
            publicId: row.user.publicId,
          }
        : undefined,
      packCodes: row.packCodes?.length ? row.packCodes : undefined,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

/** Seller-facing preview of what a code does to the shop-creation fee. */
export class CouponPreviewResponse {
  @ApiProperty() valid!: boolean;
  @ApiPropertyOptional({ example: 'HOOMRI75' }) code?: string;
  @ApiPropertyOptional({ example: 75 }) percentOff?: number;
  @ApiPropertyOptional({
    example: 500,
    description: 'Fixed-amount coupon, in ৳',
  })
  amountOff?: number;
  /** Fee before discount, major units (৳). */
  @ApiProperty({ example: 599 }) amount!: number;
  @ApiPropertyOptional({ example: 899.25 }) discount?: number;
  /** What the seller actually pays, major units (৳). */
  @ApiProperty({ example: 299.75 }) total!: number;
  @ApiProperty({ example: 'BDT' }) currency!: string;
  @ApiPropertyOptional({ example: 'This coupon has expired.' })
  reason?: string;
}
