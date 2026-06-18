import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import {
  orderItems,
  orders,
  products,
  reviews,
  type ProductRow,
} from '../../database/schema';
import type { BuyerPrincipal } from '../../common/types/principal';
import { ShopsService } from '../shops/shops.service';
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
    email: string,
  ): Promise<boolean> {
    const [row] = await this.db
      .select({ id: orders.id })
      .from(orders)
      .innerJoin(orderItems, eq(orderItems.orderId, orders.id))
      .where(
        and(
          eq(orderItems.productId, productId),
          sql`lower(${orders.email}) = ${email.toLowerCase()}`,
        ),
      )
      .limit(1);
    return !!row;
  }

  private async existingReview(productId: string, buyerId: string) {
    return this.db.query.reviews.findFirst({
      where: and(eq(reviews.productId, productId), eq(reviews.buyerId, buyerId)),
    });
  }

  async eligibility(
    handle: string,
    slug: string,
    buyer: BuyerPrincipal,
  ): Promise<ReviewEligibilityResponse> {
    const product = await this.resolveProduct(handle, slug);
    const [purchased, existing] = await Promise.all([
      this.hasPurchased(product.id, buyer.email),
      this.existingReview(product.id, buyer.id),
    ]);
    return { purchased, alreadyReviewed: !!existing };
  }

  async create(
    handle: string,
    slug: string,
    buyer: BuyerPrincipal,
    dto: CreateReviewDto,
  ): Promise<ReviewResponse> {
    const product = await this.resolveProduct(handle, slug);

    if (!(await this.hasPurchased(product.id, buyer.email))) {
      throw new ForbiddenException(
        'Only buyers who purchased this product can review it.',
      );
    }
    if (await this.existingReview(product.id, buyer.id)) {
      throw new ConflictException('You have already reviewed this product.');
    }

    const [row] = await this.db
      .insert(reviews)
      .values({
        productId: product.id,
        buyerId: buyer.id,
        author: buyer.name,
        rating: dto.rating,
        body: dto.body ?? '',
        imageUrl: dto.image ?? null,
        verified: true,
      })
      .returning();

    await this.recomputeAggregate(product.id);
    return ReviewResponse.fromRow(row);
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
