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
import { StorageService } from '../storage/storage.service';
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
    private readonly storage: StorageService,
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
    // Showcase items can't be ordered online, so stock is meaningless for
    // them — pin it to 0 regardless of what the caller sends.
    const listingType = dto.listingType ?? 'sale';
    // Upload any inline base64 photos to object storage, keeping only the URLs.
    const images = await this.storage.absorbMany(dto.images, 'products');
    const [row] = await this.db
      .insert(products)
      .values({
        shopId,
        name: dto.name,
        slug,
        cat: dto.cat,
        listingType,
        priceCents: dollarsToCents(dto.price),
        unit: dto.unit,
        stock: listingType === 'showcase' ? 0 : (dto.stock ?? 0),
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
        images: images ?? undefined,
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
    const current = await this.requireOwned(shopId, id);
    // Absorb any newly-added base64 photos; existing /media URLs pass through.
    const images =
      dto.images === undefined
        ? undefined
        : ((await this.storage.absorbMany(dto.images, 'products')) ?? undefined);
    const patch: Partial<ProductRow> = {
      name: dto.name ?? undefined,
      cat: dto.cat ?? undefined,
      listingType: dto.listingType ?? undefined,
      unit: dto.unit ?? undefined,
      stock: dto.stock ?? undefined,
      emoji: dto.emoji ?? undefined,
      tone: dto.tone ?? undefined,
      tag: dto.tag ?? undefined,
      paymentMethods: dto.paymentMethods ?? undefined,
      rating: dto.rating ?? undefined,
      blurb: dto.blurb ?? undefined,
      images,
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
    // Same invariant as create: a showcase item (whether it just became one
    // or already was) never carries stock.
    if ((dto.listingType ?? current.listingType) === 'showcase') {
      patch.stock = 0;
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
