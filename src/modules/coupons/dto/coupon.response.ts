import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { CouponRow } from '../../../database/schema';

/** Platform-admin console view of a coupon. */
export class CouponResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'HOOMRI75' }) code!: string;
  @ApiPropertyOptional() description?: string;
  @ApiProperty({ example: 75 }) percentOff!: number;
  @ApiProperty() active!: boolean;
  @ApiPropertyOptional() maxRedemptions?: number;
  @ApiProperty() redemptions!: number;
  @ApiPropertyOptional() expiresAt?: string;
  @ApiProperty() createdAt!: string;

  static fromRow(row: CouponRow): CouponResponse {
    return {
      id: row.id,
      code: row.code,
      description: row.description ?? undefined,
      percentOff: row.percentOff,
      active: row.active,
      maxRedemptions: row.maxRedemptions ?? undefined,
      redemptions: row.redemptions,
      expiresAt: row.expiresAt?.toISOString(),
      createdAt: row.createdAt.toISOString(),
    };
  }
}

/** Seller-facing preview of what a code does to the shop-creation fee. */
export class CouponPreviewResponse {
  @ApiProperty() valid!: boolean;
  @ApiPropertyOptional({ example: 'HOOMRI75' }) code?: string;
  @ApiPropertyOptional({ example: 75 }) percentOff?: number;
  /** Fee before discount, major units (৳). */
  @ApiProperty({ example: 1199 }) amount!: number;
  @ApiPropertyOptional({ example: 899.25 }) discount?: number;
  /** What the seller actually pays, major units (৳). */
  @ApiProperty({ example: 299.75 }) total!: number;
  @ApiProperty({ example: 'BDT' }) currency!: string;
  @ApiPropertyOptional({ example: 'This coupon has expired.' })
  reason?: string;
}
