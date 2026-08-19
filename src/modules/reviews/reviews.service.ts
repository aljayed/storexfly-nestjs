import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { ordersOwnedBy } from '../../common/utils/order-owner.util';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import {
  orderItems,
  orders,
  products,
  reviews,
  type ProductRow,
} from '../../database/schema';
import type { AccountPrincipal } from '../../common/types/principal';
import { ShopsService } from '../shops/shops.service';
import { StorageService } from '../storage/storage.service';
import { ReviewResponse } from '../products/dto/product-detail.response';
import {
  CreateReviewDto,
  ReviewEligibilityResponse,
} from './dto/create-review.dto';

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
