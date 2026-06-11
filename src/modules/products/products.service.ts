import {
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq } from 'drizzle-orm';
import { dollarsToCents } from '../../common/utils/money.util';
import { handleize } from '../../common/utils/slug.util';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import {
  products,
  reviews,
  type ProductRow,
} from '../../database/schema';
import { ShopsService } from '../shops/shops.service';
import type { CreateProductDto } from './dto/create-product.dto';
import { ProductDetailResponse } from './dto/product-detail.response';
import { ProductResponse } from './dto/product.response';
import { ShopResponse } from '../shops/dto/shop.response';
import type { UpdateProductDto } from './dto/update-product.dto';

@Injectable()
export class ProductsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly shops: ShopsService,
  ) {}

  /** Public catalog listing for a storefront, optionally filtered by category. */
  async listByHandle(
    handle: string,
    cat?: string,
  ): Promise<{ shop: ShopResponse; products: ProductResponse[] }> {
    const shop = await this.shops.requireLiveByHandle(handle);
    const filterByCat = cat && cat.toLowerCase() !== 'all';
    const rows = await this.db.query.products.findMany({
      where: filterByCat
        ? and(eq(products.shopId, shop.id), eq(products.cat, cat))
        : eq(products.shopId, shop.id),
      orderBy: [desc(products.createdAt)],
    });
    return {
      shop: ShopResponse.fromRow(shop),
      products: rows.map(ProductResponse.fromRow),
    };
  }

  /** Public product page — product + reviews + rating distribution. */
  async getBySlug(
    handle: string,
    slug: string,
  ): Promise<ProductDetailResponse> {
    const shop = await this.shops.requireLiveByHandle(handle);
    const product = await this.db.query.products.findFirst({
      where: and(eq(products.shopId, shop.id), eq(products.slug, slug)),
    });
    if (!product) {
      throw new NotFoundException('Product not found');
    }
    const productReviews = await this.db.query.reviews.findMany({
      where: eq(reviews.productId, product.id),
      orderBy: [desc(reviews.createdAt)],
    });
    return ProductDetailResponse.fromRows(product, productReviews);
  }

  async create(shopId: string, dto: CreateProductDto): Promise<ProductResponse> {
    await this.shops.requireById(shopId);
    const slug = await this.uniqueSlug(shopId, dto.name);
    const [row] = await this.db
      .insert(products)
      .values({
        shopId,
        name: dto.name,
        slug,
        cat: dto.cat,
        priceCents: dollarsToCents(dto.price),
        unit: dto.unit,
        stock: dto.stock ?? 0,
        deliveryDhakaCents:
          dto.deliveryDhaka !== undefined
            ? dollarsToCents(dto.deliveryDhaka)
            : undefined,
        deliveryOutsideCents:
          dto.deliveryOutside !== undefined
            ? dollarsToCents(dto.deliveryOutside)
            : undefined,
        emoji: dto.emoji ?? '📦',
        tone: dto.tone ?? '#f3f1ec',
        tag: dto.tag,
        paymentMethods: dto.paymentMethods ?? undefined,
        rating: dto.rating ?? 0,
        blurb: dto.blurb ?? '',
        images: dto.images,
        highlights: dto.highlights,
        videoUrl: dto.videoUrl || null,
      })
      .returning();
    return ProductResponse.fromRow(row);
  }

  async update(
    shopId: string,
    id: string,
    dto: UpdateProductDto,
  ): Promise<ProductResponse> {
    await this.requireOwned(shopId, id);
    const patch: Partial<ProductRow> = {
      name: dto.name ?? undefined,
      cat: dto.cat ?? undefined,
      unit: dto.unit ?? undefined,
      stock: dto.stock ?? undefined,
      emoji: dto.emoji ?? undefined,
      tone: dto.tone ?? undefined,
      tag: dto.tag ?? undefined,
      paymentMethods: dto.paymentMethods ?? undefined,
      rating: dto.rating ?? undefined,
      blurb: dto.blurb ?? undefined,
      images: dto.images ?? undefined,
      // Present (incl. empty array) replaces the list; absent leaves it as-is.
      highlights: dto.highlights ?? undefined,
      // Present-but-empty clears the video; absent leaves it unchanged.
      videoUrl: dto.videoUrl === undefined ? undefined : dto.videoUrl || null,
    };
    if (dto.price !== undefined) {
      patch.priceCents = dollarsToCents(dto.price);
    }
    if (dto.deliveryDhaka !== undefined) {
      patch.deliveryDhakaCents = dollarsToCents(dto.deliveryDhaka);
    }
    if (dto.deliveryOutside !== undefined) {
      patch.deliveryOutsideCents = dollarsToCents(dto.deliveryOutside);
    }
    const [row] = await this.db
      .update(products)
      .set(patch)
      .where(eq(products.id, id))
      .returning();
    return ProductResponse.fromRow(row);
  }

  async remove(shopId: string, id: string): Promise<{ ok: true }> {
    await this.requireOwned(shopId, id);
    await this.db.delete(products).where(eq(products.id, id));
    return { ok: true };
  }

  /** Lists every product of a shop (admin items view). */
  async listForShop(shopId: string): Promise<ProductResponse[]> {
    const rows = await this.db.query.products.findMany({
      where: eq(products.shopId, shopId),
      orderBy: [asc(products.name)],
    });
    return rows.map(ProductResponse.fromRow);
  }

  private async requireOwned(shopId: string, id: string): Promise<ProductRow> {
    const product = await this.db.query.products.findFirst({
      where: and(eq(products.id, id), eq(products.shopId, shopId)),
    });
    if (!product) {
      throw new NotFoundException('Product not found in this shop');
    }
    return product;
  }

  private async uniqueSlug(shopId: string, name: string): Promise<string> {
    const base = handleize(name) || 'item';
    let slug = base;
    let suffix = 1;
    // Slugs are unique per shop; append -2, -3, … on collision.
    while (
      await this.db.query.products.findFirst({
        where: and(eq(products.shopId, shopId), eq(products.slug, slug)),
        columns: { id: true },
      })
    ) {
      suffix += 1;
      slug = `${base}-${suffix}`;
    }
    return slug;
  }
}
