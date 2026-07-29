import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { centsToDollars, dollarsToCents } from '../../common/utils/money.util';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import {
  combos,
  products,
  shopCouponRedemptions,
  shopCoupons,
  type NewShopCouponRow,
  type ShopCouponRow,
} from '../../database/schema';
import {
  CouponQuoteResponse,
  ShopCouponResponse,
} from './dto/shop-coupon.response';
import type {
  CreateShopCouponDto,
  UpdateShopCouponDto,
} from './dto/create-shop-coupon.dto';

/** Any Drizzle executor — the pooled client or a checkout transaction. */
type Executor =
  | DrizzleDB
  | Parameters<Parameters<DrizzleDB['transaction']>[0]>[0];

/** Why a code was refused. Localized by the Vue app, never sent as prose. */
export type CouponRejection =
  | 'not_found'
  | 'inactive'
  | 'scheduled'
  | 'expired'
  | 'exhausted'
  | 'customer_limit'
  | 'min_order'
  | 'not_applicable';

/**
 * The priced order a coupon is being judged against. Built by the checkout
 * cart builders, so a quote and the real checkout see identical numbers.
 */
export interface CouponBasis {
  /** Item subtotal in cents — the order total minus delivery. */
  itemsSubtotalCents: number;
  /** Per-product item value, keyed by product id (delivery/adjustments excluded). */
  valueByProduct: Map<string, number>;
  /** Set when this checkout is a combo order. */
  comboId?: string;
  /** Normalized national phone of the buyer, for the per-customer cap. */
  phone: string;
}

export interface CouponOutcome {
  coupon: ShopCouponRow;
  discountCents: number;
}

/** Reduce any BD phone format to the bare national number. */
export function normalizeCouponPhone(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\D/g, '').replace(/^880/, '').replace(/^0+/, '');
}

/**
 * Buyer-facing discount codes owned by a shop.
 *
 * Two responsibilities: seller CRUD from the console, and the checkout-time
 * decision of whether a typed code applies to this particular order and what
 * it takes off. The discount only ever touches the item subtotal — delivery
 * is excluded, because the seller still owes the courier that money.
 */
@Injectable()
export class ShopCouponsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  // ── Seller console ───────────────────────────────────────────────

  /** Every coupon of the shop, newest first, with its target's name. */
  async listForShop(shopId: string): Promise<ShopCouponResponse[]> {
    const rows = await this.db.query.shopCoupons.findMany({
      where: eq(shopCoupons.shopId, shopId),
      orderBy: [desc(shopCoupons.createdAt)],
      with: { product: true, combo: true },
    });
    return rows.map((r) =>
      ShopCouponResponse.from(r, r.product?.name ?? r.combo?.name ?? undefined),
    );
  }

  async create(
    shopId: string,
    dto: CreateShopCouponDto,
  ): Promise<ShopCouponResponse> {
    const values = await this.toRowValues(shopId, dto, null);
    const code = (dto.code ?? '').trim().toUpperCase();

    const existing = await this.db.query.shopCoupons.findFirst({
      where: and(eq(shopCoupons.shopId, shopId), eq(shopCoupons.code, code)),
    });
    if (existing) {
      throw new ConflictException('That coupon code already exists');
    }

    // `discountType`, `value` and `scope` are required by the create DTO, so
    // `toRowValues` has always resolved them by here.
    const [row] = await this.db
      .insert(shopCoupons)
      .values({
        ...values,
        shopId,
        code,
        discountType: dto.discountType,
        scope: dto.scope,
        value: values.value as number,
      })
      .returning();
    return ShopCouponResponse.from(row, await this.targetName(row));
  }

  async update(
    shopId: string,
    id: string,
    dto: UpdateShopCouponDto,
  ): Promise<ShopCouponResponse> {
    const current = await this.mustFind(shopId, id);
    const values = await this.toRowValues(shopId, dto, current);

    if (dto.code !== undefined) {
      const code = dto.code.trim().toUpperCase();
      if (code !== current.code) {
        const clash = await this.db.query.shopCoupons.findFirst({
          where: and(
            eq(shopCoupons.shopId, shopId),
            eq(shopCoupons.code, code),
          ),
        });
        if (clash) {
          throw new ConflictException('That coupon code already exists');
        }
      }
      values.code = code;
    }

    const [row] = await this.db
      .update(shopCoupons)
      .set(values)
      .where(and(eq(shopCoupons.id, id), eq(shopCoupons.shopId, shopId)))
      .returning();
    return ShopCouponResponse.from(row, await this.targetName(row));
  }

  async remove(shopId: string, id: string): Promise<{ ok: true }> {
    await this.mustFind(shopId, id);
    await this.db
      .delete(shopCoupons)
      .where(and(eq(shopCoupons.id, id), eq(shopCoupons.shopId, shopId)));
    return { ok: true };
  }

  private async mustFind(shopId: string, id: string): Promise<ShopCouponRow> {
    const row = await this.db.query.shopCoupons.findFirst({
      where: and(eq(shopCoupons.id, id), eq(shopCoupons.shopId, shopId)),
    });
    if (!row) throw new NotFoundException('Coupon not found in this shop');
    return row;
  }

  private async targetName(row: ShopCouponRow): Promise<string | undefined> {
    if (row.productId) {
      const p = await this.db.query.products.findFirst({
        where: eq(products.id, row.productId),
      });
      return p?.name;
    }
    if (row.comboId) {
      const c = await this.db.query.combos.findFirst({
        where: eq(combos.id, row.comboId),
      });
      return c?.name;
    }
    return undefined;
  }

  /**
   * Validate the seller's input and convert the ৳ fields to cents. `current`
   * is the existing row on an update, so partial edits keep their meaning
   * (e.g. changing only `value` on a coupon that is already a percentage).
   */
  private async toRowValues(
    shopId: string,
    dto: UpdateShopCouponDto,
    current: ShopCouponRow | null,
  ): Promise<Partial<NewShopCouponRow>> {
    const values: Partial<NewShopCouponRow> = {};
    const type = dto.discountType ?? current?.discountType ?? 'percent';
    const scope = dto.scope ?? current?.scope ?? 'all';

    if (dto.discountType !== undefined) values.discountType = dto.discountType;

    if (dto.value !== undefined) {
      if (type === 'percent') {
        if (!Number.isInteger(dto.value) || dto.value < 1 || dto.value > 100) {
          throw new BadRequestException(
            'A percentage discount must be a whole number between 1 and 100',
          );
        }
        values.value = dto.value;
      } else {
        const cents = dollarsToCents(dto.value);
        if (cents < 1) {
          throw new BadRequestException('The discount amount must be above 0');
        }
        values.value = cents;
      }
    } else if (dto.discountType !== undefined && current) {
      // Switching type without restating the value would reinterpret it
      // (25% silently becoming ৳0.25), so make the seller send both.
      throw new BadRequestException(
        'Send the discount value together with a change of discount type',
      );
    }

    if (dto.maxDiscount !== undefined) {
      values.maxDiscountCents =
        dto.maxDiscount === null ? null : dollarsToCents(dto.maxDiscount);
    }
    if (dto.minOrder !== undefined) {
      values.minOrderCents = dollarsToCents(dto.minOrder);
    }
    if (dto.active !== undefined) values.active = dto.active;
    if (dto.maxRedemptions !== undefined) {
      values.maxRedemptions = dto.maxRedemptions ?? null;
    }
    if (dto.perCustomerLimit !== undefined) {
      values.perCustomerLimit = dto.perCustomerLimit ?? null;
    }
    if (dto.description !== undefined) {
      values.description = dto.description?.trim() || null;
    }

    const startsAt =
      dto.startsAt !== undefined
        ? dto.startsAt
          ? new Date(dto.startsAt)
          : null
        : (current?.startsAt ?? null);
    const expiresAt =
      dto.expiresAt !== undefined
        ? dto.expiresAt
          ? new Date(dto.expiresAt)
          : null
        : (current?.expiresAt ?? null);
    if (startsAt && expiresAt && expiresAt.getTime() <= startsAt.getTime()) {
      throw new BadRequestException('The end date must come after the start');
    }
    if (dto.startsAt !== undefined) values.startsAt = startsAt;
    if (dto.expiresAt !== undefined) values.expiresAt = expiresAt;

    // Scope target: exactly the one the scope calls for, owned by this shop.
    if (
      dto.scope !== undefined ||
      dto.productId !== undefined ||
      dto.comboId !== undefined
    ) {
      values.scope = scope;
      values.productId = null;
      values.comboId = null;

      if (scope === 'product') {
        const productId = dto.productId ?? current?.productId ?? undefined;
        if (!productId) {
          throw new BadRequestException('Pick the product this coupon is for');
        }
        const product = await this.db.query.products.findFirst({
          where: and(eq(products.id, productId), eq(products.shopId, shopId)),
        });
        if (!product) {
          throw new NotFoundException('Product not found in this shop');
        }
        // Showcase items are advertised only — they can never be bought
        // online, so a coupon for one could never be redeemed.
        if (product.listingType !== 'sale') {
          throw new BadRequestException(
            `“${product.name}” is a showcase-only listing and cannot be ordered online, so a coupon for it would never apply.`,
          );
        }
        values.productId = productId;
      } else if (scope === 'combo') {
        const comboId = dto.comboId ?? current?.comboId ?? undefined;
        if (!comboId) {
          throw new BadRequestException('Pick the combo this coupon is for');
        }
        const combo = await this.db.query.combos.findFirst({
          where: and(eq(combos.id, comboId), eq(combos.shopId, shopId)),
        });
        if (!combo) {
          throw new NotFoundException('Combo not found in this shop');
        }
        values.comboId = comboId;
      }
    }

    return values;
  }

  // ── Checkout ─────────────────────────────────────────────────────

  /**
   * Decide what a typed code takes off a priced order.
   *
   * Returns the rejection key instead of throwing so the storefront can
   * preview a code without an error response; `redeem` is what actually
   * commits a use, and it re-checks the caps under the checkout's lock.
   */
  async evaluate(
    executor: Executor,
    shopId: string,
    rawCode: string,
    basis: CouponBasis,
  ): Promise<
    CouponOutcome | { rejection: CouponRejection; coupon?: ShopCouponRow }
  > {
    const code = (rawCode ?? '').trim().toUpperCase();
    if (!code) return { rejection: 'not_found' };

    const [coupon] = await executor
      .select()
      .from(shopCoupons)
      .where(and(eq(shopCoupons.shopId, shopId), eq(shopCoupons.code, code)))
      .limit(1);
    if (!coupon) return { rejection: 'not_found' };
    if (!coupon.active) return { rejection: 'inactive', coupon };

    const now = Date.now();
    if (coupon.startsAt && coupon.startsAt.getTime() > now) {
      return { rejection: 'scheduled', coupon };
    }
    if (coupon.expiresAt && coupon.expiresAt.getTime() <= now) {
      return { rejection: 'expired', coupon };
    }
    if (
      coupon.maxRedemptions !== null &&
      coupon.redemptions >= coupon.maxRedemptions
    ) {
      return { rejection: 'exhausted', coupon };
    }
    if (basis.itemsSubtotalCents < coupon.minOrderCents) {
      return { rejection: 'min_order', coupon };
    }

    if (coupon.perCustomerLimit !== null && basis.phone) {
      const [{ used }] = await executor
        .select({ used: sql<string>`count(*)` })
        .from(shopCouponRedemptions)
        .where(
          and(
            eq(shopCouponRedemptions.couponId, coupon.id),
            eq(shopCouponRedemptions.phone, basis.phone),
          ),
        );
      if (Number(used) >= coupon.perCustomerLimit) {
        return { rejection: 'customer_limit', coupon };
      }
    }

    const base = this.discountableCents(coupon, basis);
    if (base <= 0) return { rejection: 'not_applicable', coupon };

    const discountCents = this.discountFor(coupon, base);
    if (discountCents <= 0) return { rejection: 'not_applicable', coupon };

    return { coupon, discountCents };
  }

  /**
   * The slice of the order this coupon may discount.
   *
   * `all` covers the whole item subtotal (already net of any combo discount).
   * `product` covers only that product's lines, and never applies to a combo
   * order — the combo price is its own discount, and stacking a per-product
   * code on top of it would double-discount the same item.
   */
  private discountableCents(coupon: ShopCouponRow, basis: CouponBasis): number {
    if (coupon.scope === 'combo') {
      return coupon.comboId && coupon.comboId === basis.comboId
        ? basis.itemsSubtotalCents
        : 0;
    }
    if (coupon.scope === 'product') {
      if (basis.comboId) return 0;
      return coupon.productId
        ? (basis.valueByProduct.get(coupon.productId) ?? 0)
        : 0;
    }
    return basis.itemsSubtotalCents;
  }

  /** Percent (optionally capped) or flat amount, never more than the base. */
  private discountFor(coupon: ShopCouponRow, baseCents: number): number {
    let discount =
      coupon.discountType === 'percent'
        ? Math.floor((baseCents * coupon.value) / 100)
        : coupon.value;
    if (
      coupon.discountType === 'percent' &&
      coupon.maxDiscountCents !== null &&
      discount > coupon.maxDiscountCents
    ) {
      discount = coupon.maxDiscountCents;
    }
    return Math.max(0, Math.min(discount, baseCents));
  }

  /**
   * Commit one use, inside the checkout transaction.
   *
   * The global cap is enforced by a guarded increment rather than a re-read,
   * so two buyers racing for the last redemption cannot both win.
   */
  async redeem(
    executor: Executor,
    coupon: ShopCouponRow,
    args: { orderId: string; phone: string; discountCents: number },
  ): Promise<void> {
    const claimed = await executor
      .update(shopCoupons)
      .set({ redemptions: sql`${shopCoupons.redemptions} + 1` })
      .where(
        and(
          eq(shopCoupons.id, coupon.id),
          coupon.maxRedemptions === null
            ? sql`true`
            : sql`${shopCoupons.redemptions} < ${coupon.maxRedemptions}`,
        ),
      )
      .returning({ id: shopCoupons.id });
    if (!claimed.length) {
      throw new ConflictException(
        'This coupon has just been fully redeemed — please remove it and try again.',
      );
    }
    await executor.insert(shopCouponRedemptions).values({
      couponId: coupon.id,
      orderId: args.orderId,
      phone: args.phone,
      discountCents: args.discountCents,
    });
  }

  /**
   * Give the redemption back when an order is cancelled or a gateway payment
   * never completed, so the buyer isn't charged a use for an order that never
   * happened. Idempotent — a second cancel finds no row and does nothing.
   */
  async releaseForOrder(executor: Executor, orderId: string): Promise<void> {
    const [row] = await executor
      .delete(shopCouponRedemptions)
      .where(eq(shopCouponRedemptions.orderId, orderId))
      .returning({ couponId: shopCouponRedemptions.couponId });
    if (!row) return;
    await executor
      .update(shopCoupons)
      .set({
        redemptions: sql`greatest(${shopCoupons.redemptions} - 1, 0)`,
      })
      .where(eq(shopCoupons.id, row.couponId));
  }

  /** Shape an evaluation result for the storefront's preview endpoint. */
  toQuote(
    code: string,
    result:
      | CouponOutcome
      | { rejection: CouponRejection; coupon?: ShopCouponRow },
  ): CouponQuoteResponse {
    if ('discountCents' in result) {
      return {
        valid: true,
        code: result.coupon.code,
        discount: centsToDollars(result.discountCents),
        description: result.coupon.description ?? undefined,
      };
    }
    return {
      valid: false,
      code: code.trim().toUpperCase(),
      discount: 0,
      reason: result.rejection,
      minOrder:
        result.rejection === 'min_order' && result.coupon
          ? centsToDollars(result.coupon.minOrderCents)
          : undefined,
    };
  }
}
