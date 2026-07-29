import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { centsToDollars } from '../../../common/utils/money.util';
import type { ShopCouponRow } from '../../../database/schema';

/** A shop coupon as the seller console renders it. Money in major units (৳). */
export class ShopCouponResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'EID25' }) code!: string;
  @ApiPropertyOptional() description?: string;
  @ApiProperty({ example: 'percent' }) discountType!: 'percent' | 'fixed';

  @ApiProperty({
    example: 25,
    description: 'Percentage (1–100) or, for a fixed coupon, the ৳ amount off.',
  })
  value!: number;

  @ApiPropertyOptional({ example: 500 }) maxDiscount?: number;
  @ApiProperty({ example: 1000 }) minOrder!: number;
  @ApiProperty({ example: 'all' }) scope!: 'all' | 'product' | 'combo';
  @ApiPropertyOptional() productId?: string;
  @ApiPropertyOptional() comboId?: string;

  /** Name of the scoped product/combo, for the list UI. */
  @ApiPropertyOptional({ example: 'Cotton Panjabi' }) targetName?: string;

  @ApiProperty() active!: boolean;
  @ApiPropertyOptional() startsAt?: string;
  @ApiPropertyOptional() expiresAt?: string;
  @ApiPropertyOptional({ example: 100 }) maxRedemptions?: number;
  @ApiProperty({ example: 12 }) redemptions!: number;
  @ApiPropertyOptional({ example: 1 }) perCustomerLimit?: number;

  /**
   * Whether the code would be accepted right now, ignoring cart contents —
   * drives the "Live / Scheduled / Expired / Used up / Paused" badge so the
   * console doesn't re-derive the rules.
   */
  @ApiProperty({ example: 'live' })
  state!: 'live' | 'scheduled' | 'expired' | 'exhausted' | 'paused';

  @ApiProperty() createdAt!: string;

  static from(row: ShopCouponRow, targetName?: string): ShopCouponResponse {
    const now = Date.now();
    const state: ShopCouponResponse['state'] = !row.active
      ? 'paused'
      : row.expiresAt && row.expiresAt.getTime() <= now
        ? 'expired'
        : row.maxRedemptions !== null &&
            row.redemptions >= (row.maxRedemptions ?? 0)
          ? 'exhausted'
          : row.startsAt && row.startsAt.getTime() > now
            ? 'scheduled'
            : 'live';

    return {
      id: row.id,
      code: row.code,
      description: row.description ?? undefined,
      discountType: row.discountType,
      // A percentage is a plain number; a fixed discount is money in cents.
      value:
        row.discountType === 'percent' ? row.value : centsToDollars(row.value),
      maxDiscount:
        row.maxDiscountCents === null
          ? undefined
          : centsToDollars(row.maxDiscountCents),
      minOrder: centsToDollars(row.minOrderCents),
      scope: row.scope,
      productId: row.productId ?? undefined,
      comboId: row.comboId ?? undefined,
      targetName,
      active: row.active,
      startsAt: row.startsAt?.toISOString(),
      expiresAt: row.expiresAt?.toISOString(),
      maxRedemptions: row.maxRedemptions ?? undefined,
      redemptions: row.redemptions,
      perCustomerLimit: row.perCustomerLimit ?? undefined,
      state,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

/**
 * The storefront's answer when a buyer types a code: whether it applies to the
 * cart they are looking at, and what it would take off. `reason` is a stable
 * machine key the Vue app localizes (en/bn) — never a server-language string.
 */
export class CouponQuoteResponse {
  @ApiProperty({ example: true }) valid!: boolean;
  @ApiProperty({ example: 'EID25' }) code!: string;

  @ApiProperty({ example: 250, description: 'Discount in ৳ (0 when invalid).' })
  discount!: number;

  @ApiPropertyOptional({
    example: 'min_order',
    description:
      'Why it was rejected: not_found | inactive | scheduled | expired | ' +
      'exhausted | customer_limit | min_order | not_applicable',
  })
  reason?: string;

  @ApiPropertyOptional({
    example: 1000,
    description: 'The unmet minimum, in ৳ — only set when reason = min_order.',
  })
  minOrder?: number;

  @ApiPropertyOptional({ example: 'Eid sale — 25% off everything' })
  description?: string;
}
