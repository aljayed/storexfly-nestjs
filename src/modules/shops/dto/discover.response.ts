import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { ListingType } from '../../../database/schema/enums';

/**
 * Public marketplace catalogue, shared by guests and signed-in buyers.
 * Deliberately lean: shop cards skip the banner-image payloads and product
 * cards carry only the cover image, so the feed stays a light request.
 */
export class DiscoverShopResponse {
  @ApiProperty() name!: string;
  @ApiProperty() handle!: string;
  @ApiPropertyOptional() tagline?: string;
  @ApiProperty() cat!: string;
  @ApiProperty({ example: '#e8943a' }) brand!: string;
  @ApiProperty({ example: '#fbeede' }) brandSoft!: string;
}

export class DiscoverProductResponse {
  @ApiProperty() id!: string;
  @ApiProperty() category!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
  @ApiProperty({
    enum: ['sale', 'showcase'],
    description:
      "'sale' = online checkout; 'showcase' = advertise-only, contact the seller to buy.",
  })
  listingType!: ListingType;
  @ApiProperty({
    description:
      'Unit price in the shop currency (0 on a showcase item = "contact for price")',
  })
  price!: number;
  @ApiPropertyOptional({ description: 'Actual regular price, when higher than the selling price' })
  comparePrice?: number;
  @ApiProperty() unit!: string;
  @ApiProperty() stock!: number;
  @ApiProperty() emoji!: string;
  @ApiProperty() tone!: string;
  @ApiPropertyOptional() tag?: string;
  @ApiProperty() rating!: number;
  @ApiProperty({ description: 'Review count' }) reviews!: number;
  @ApiPropertyOptional({ description: 'Cover image (data URL)' })
  image?: string;
  @ApiProperty() shopHandle!: string;
  @ApiProperty() shopName!: string;
  @ApiProperty({ example: 'BDT', description: 'Currency the shop prices in' })
  currency!: string;
}

export class DiscoverCategoryResponse {
  @ApiProperty() name!: string;
  @ApiProperty() count!: number;
}

export class DiscoverResponse {
  @ApiProperty({ type: [DiscoverShopResponse] })
  shops!: DiscoverShopResponse[];
  @ApiProperty({ type: [DiscoverProductResponse] })
  products!: DiscoverProductResponse[];
  @ApiProperty({ type: [DiscoverCategoryResponse] })
  categories!: DiscoverCategoryResponse[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() hasMore!: boolean;
}
