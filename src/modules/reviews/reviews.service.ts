import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, isNull, lte, sql, type SQL } from 'drizzle-orm';
import { ordersOwnedBy } from '../../common/utils/order-owner.util';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import {
  orderItems,
  orders,
  products,
  reviews,
  shops,
  type ProductRow,
} from '../../database/schema';
import { NotificationsService } from '../notifications/notifications.service';
import type { AccountPrincipal } from '../../common/types/principal';
import { ShopsService } from '../shops/shops.service';
import { StorageService } from '../storage/storage.service';
import { ReviewResponse } from '../products/dto/product-detail.response';
import {
  CreateReviewDto,
  ReviewEligibilityResponse,
  ShopReviewsQuery,
} from './dto/create-review.dto';

const SHOP_PAGE = 30;

/** A review as the seller console lists it: the review plus which item. */
export interface ShopReviewView extends ReviewResponse {
  product: {
    id: string;
    name: string;
    slug: string;
    imageUrl: string | null;
    emoji: string;
    tone: string;
  };
}

/**
 * Buyer-written reviews. A buyer may review a product only if an order placed
 * with their account email contains it, and only once per product. Such reviews
 * are flagged `verified`.
 */
@Injectable()
export class ReviewsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly shops: ShopsService,
    private readonly storage: StorageService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Resolve the product behind a public /shops/:handle/products/:slug URL. */
  private async resolveProduct(
    handle: string,
    slug: string,
  ): Promise<ProductRow> {
    const shop = await this.shops.requireLiveByHandle(handle);
    const product = await this.db.query.products.findFirst({
      where: and(eq(products.shopId, shop.id), eq(products.slug, slug)),
    });
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  /** True if an order under this buyer's email includes the product. */
  private async hasPurchased(
    productId: string,
    accountId: string,
    email?: string | null,
  ): Promise<boolean> {
    const [row] = await this.db
      .select({ id: orders.id })
      .from(orders)
      .innerJoin(orderItems, eq(orderItems.orderId, orders.id))
      .where(
        and(
          eq(orderItems.productId, productId),
          // Keyed on the account, so a reviewer who changed their email does
          // not silently lose the purchase that entitles them to review.
          ordersOwnedBy(accountId, email),
        ),
      )
      .limit(1);
    return !!row;
  }

  private async existingReview(productId: string, buyerId: string) {
    return this.db.query.reviews.findFirst({
      where: and(
        eq(reviews.productId, productId),
        eq(reviews.buyerId, buyerId),
      ),
    });
  }

  /** Load a review and assert it exists on this product and belongs to the buyer. */
  private async requireOwnReview(
    reviewId: string,
    productId: string,
    buyerId: string,
  ) {
    const row = await this.db.query.reviews.findFirst({
      where: eq(reviews.id, reviewId),
    });
    if (!row || row.productId !== productId) {
      throw new NotFoundException('Review not found');
    }
    if (row.buyerId !== buyerId) {
      throw new ForbiddenException('You can only change your own review.');
    }
    return row;
  }

  async eligibility(
    handle: string,
    slug: string,
    buyer: AccountPrincipal,
  ): Promise<ReviewEligibilityResponse> {
    const product = await this.resolveProduct(handle, slug);
    const [purchased, existing] = await Promise.all([
      this.hasPurchased(product.id, buyer.id, buyer.email),
      this.existingReview(product.id, buyer.id),
    ]);
    return {
      purchased,
      alreadyReviewed: !!existing,
      reviewId: existing?.id ?? null,
    };
  }

  async create(
    handle: string,
    slug: string,
    buyer: AccountPrincipal,
    dto: CreateReviewDto,
  ): Promise<ReviewResponse> {
    const product = await this.resolveProduct(handle, slug);

    if (!(await this.hasPurchased(product.id, buyer.id, buyer.email))) {
      throw new ForbiddenException(
        'Only buyers who purchased this product can review it.',
      );
    }
    if (await this.existingReview(product.id, buyer.id)) {
      throw new ConflictException('You have already reviewed this product.');
    }

    const imageUrl = (await this.storage.absorb(dto.image, 'reviews')) ?? null;
    const [row] = await this.db
      .insert(reviews)
      .values({
        productId: product.id,
        buyerId: buyer.id,
        author: buyer.name,
        rating: dto.rating,
        body: dto.body ?? '',
        imageUrl,
        verified: true,
      })
      .returning();

    await this.recomputeAggregate(product.id);
    return ReviewResponse.fromRow(row);
  }

  /** Edit the buyer's own review (rating / text / photo). */
  async update(
    handle: string,
    slug: string,
    reviewId: string,
    buyer: AccountPrincipal,
    dto: CreateReviewDto,
  ): Promise<ReviewResponse> {
    const product = await this.resolveProduct(handle, slug);
    await this.requireOwnReview(reviewId, product.id, buyer.id);

    const imageUrl = (await this.storage.absorb(dto.image, 'reviews')) ?? null;
    const [row] = await this.db
      .update(reviews)
      .set({
        rating: dto.rating,
        body: dto.body ?? '',
        imageUrl,
      })
      .where(eq(reviews.id, reviewId))
      .returning();

    await this.recomputeAggregate(product.id);
    return ReviewResponse.fromRow(row);
  }

  /** Delete the buyer's own review. */
  async remove(
    handle: string,
    slug: string,
    reviewId: string,
    buyer: AccountPrincipal,
  ): Promise<{ deleted: true }> {
    const product = await this.resolveProduct(handle, slug);
    await this.requireOwnReview(reviewId, product.id, buyer.id);

    await this.db.delete(reviews).where(eq(reviews.id, reviewId));
    await this.recomputeAggregate(product.id);
    return { deleted: true };
  }

  /* ---------- seller console ---------- */

  /**
   * The shop's reviews, newest first, plus the numbers the page leads with.
   * "Critical" is 3 stars and under - the ones a reply matters most on.
   */
  async listForShop(
    shopId: string,
    query: ShopReviewsQuery,
  ): Promise<{
    items: ShopReviewView[];
    nextCursor: number | null;
    summary: { total: number; unreplied: number; average: number };
  }> {
    const offset = query.cursor ?? 0;
    const inShop = eq(products.shopId, shopId);
    const filter: SQL | undefined =
      query.filter === 'unreplied'
        ? isNull(reviews.reply)
        : query.filter === 'critical'
          ? lte(reviews.rating, 3)
          : undefined;

    const [rows, [summary]] = await Promise.all([
      this.db
        .select({ review: reviews, product: products })
        .from(reviews)
        .innerJoin(products, eq(products.id, reviews.productId))
        .where(and(inShop, filter))
        .orderBy(desc(reviews.createdAt), desc(reviews.id))
        .limit(SHOP_PAGE + 1)
        .offset(offset),
      this.db
        .select({
          total: sql<number>`count(*)::int`,
          unreplied: sql<number>`count(*) filter (where ${reviews.reply} is null)::int`,
          average: sql<number>`coalesce(avg(${reviews.rating}), 0)`,
        })
        .from(reviews)
        .innerJoin(products, eq(products.id, reviews.productId))
        .where(inShop),
    ]);

    return {
      items: rows.slice(0, SHOP_PAGE).map(({ review, product }) => ({
        ...ReviewResponse.fromRow(review),
        product: {
          id: product.id,
          name: product.name,
          slug: product.slug,
          imageUrl: product.images?.[0] ?? null,
          emoji: product.emoji,
          tone: product.tone,
        },
      })),
      nextCursor: rows.length > SHOP_PAGE ? offset + SHOP_PAGE : null,
      summary: {
        total: Number(summary?.total ?? 0),
        unreplied: Number(summary?.unreplied ?? 0),
        average: Math.round((Number(summary?.average) || 0) * 10) / 10,
      },
    };
  }

  /**
   * Post or edit the shop's reply. The reviewer hears about the first reply
   * only - an edit to fix a typo shouldn't ping them again.
   */
  async reply(
    shopId: string,
    reviewId: string,
    body: string,
  ): Promise<ReviewResponse> {
    const { review, product } = await this.requireShopReview(shopId, reviewId);
    const [row] = await this.db
      .update(reviews)
      .set({ reply: body, repliedAt: new Date() })
      .where(eq(reviews.id, review.id))
      .returning();

    if (!review.reply && review.buyerId) {
      const shop = await this.db.query.shops.findFirst({
        where: eq(shops.id, shopId),
        columns: { id: true, name: true, handle: true },
      });
      if (shop) {
        await this.notifications.reviewReply(
          review.buyerId,
          shop,
          product.name,
          body,
        );
      }
    }
    return ReviewResponse.fromRow(row);
  }

  async removeReply(shopId: string, reviewId: string): Promise<ReviewResponse> {
    const { review } = await this.requireShopReview(shopId, reviewId);
    const [row] = await this.db
      .update(reviews)
      .set({ reply: null, repliedAt: null })
      .where(eq(reviews.id, review.id))
      .returning();
    return ReviewResponse.fromRow(row);
  }

  /** A review on one of this shop's products - anything else reads as missing. */
  private async requireShopReview(shopId: string, reviewId: string) {
    const [hit] = await this.db
      .select({ review: reviews, product: products })
      .from(reviews)
      .innerJoin(products, eq(products.id, reviews.productId))
      .where(and(eq(reviews.id, reviewId), eq(products.shopId, shopId)))
      .limit(1);
    if (!hit) throw new NotFoundException('Review not found');
    return hit;
  }

  /** Keep the product's denormalized rating + count in sync with its reviews. */
  private async recomputeAggregate(productId: string): Promise<void> {
    const [agg] = await this.db
      .select({
        count: sql<number>`count(*)::int`,
        avg: sql<number>`coalesce(avg(${reviews.rating}), 0)`,
      })
      .from(reviews)
      .where(eq(reviews.productId, productId));
    await this.db
      .update(products)
      .set({
        reviewsCount: agg?.count ?? 0,
        rating: Math.round((Number(agg?.avg) || 0) * 10) / 10,
      })
      .where(eq(products.id, productId));
  }
}
