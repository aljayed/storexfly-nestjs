import { ApiProperty } from '@nestjs/swagger';
import type { ProductRow, ReviewRow } from '../../../database/schema';
import { ComboResponse } from '../../combos/dto/combo.response';
import { ProductResponse } from './product.response';

export class ReviewResponse {
  @ApiProperty() id!: string;
  @ApiProperty() author!: string;
  @ApiProperty() rating!: number;
  @ApiProperty() body!: string;
  @ApiProperty({ nullable: true }) imageUrl!: string | null;
  @ApiProperty() verified!: boolean;
  @ApiProperty() createdAt!: string;

  static fromRow(row: ReviewRow): ReviewResponse {
    return {
      id: row.id,
      author: row.author,
      rating: row.rating,
      body: row.body,
      imageUrl: row.imageUrl ?? null,
      verified: row.verified,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

/** Rating distribution buckets 1★..5★ for the product page bars. */
export interface RatingDistribution {
  1: number;
  2: number;
  3: number;
  4: number;
  5: number;
}

/** Product page payload: the product plus its reviews and aggregates. */
export class ProductDetailResponse extends ProductResponse {
  @ApiProperty({ type: [ReviewResponse] })
  reviewList!: ReviewResponse[];

  @ApiProperty({ description: 'Count of reviews per star (1..5)' })
  ratingDistribution!: RatingDistribution;

  @ApiProperty({
    type: [ComboResponse],
    description: 'Live combo offers that include this product',
  })
  combos!: ComboResponse[];

  static fromRows(
    product: ProductRow,
    reviews: ReviewRow[],
    combos: ComboResponse[] = [],
  ): ProductDetailResponse {
    const base = ProductResponse.fromRow(product);
    const distribution: RatingDistribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const r of reviews) {
      const bucket = Math.min(5, Math.max(1, Math.round(r.rating)));
      distribution[bucket as 1 | 2 | 3 | 4 | 5] += 1;
    }
    return {
      ...base,
      reviewList: reviews.map(ReviewResponse.fromRow),
      ratingDistribution: distribution,
      combos,
    };
  }
}
