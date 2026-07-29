import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { and, asc, count, desc, eq } from 'drizzle-orm';
import { FREE_MAX_PRODUCTS } from '../../common/constants/billing';
import { dollarsToCents } from '../../common/utils/money.util';
import { handleize } from '../../common/utils/slug.util';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import {
  products,
  reviews,
  subscriptions,
  type ProductPack,
  type ProductRow,
  type ProductVariantGroup,
} from '../../database/schema';
import { StorageService } from '../storage/storage.service';
import { ShopsService } from '../shops/shops.service';
import { CombosService } from '../combos/combos.service';
import { ComboResponse } from '../combos/dto/combo.response';
import type {
  CreateProductDto,
  PackDto,
  VariantGroupDto,
} from './dto/create-product.dto';
import { ProductDetailResponse } from './dto/product-detail.response';
import { ProductResponse } from './dto/product.response';
import { ShopResponse } from '../shops/dto/shop.response';
import type { UpdateProductDto } from './dto/update-product.dto';

/** Short random id for variant groups/options/packs inside a product row. */
const shortId = () => randomUUID().replace(/-/g, '').slice(0, 10);

@Injectable()
export class ProductsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly shops: ShopsService,
    private readonly storage: StorageService,
    private readonly combos: CombosService,
  ) {}

  /** Normalize variant-group DTOs to storage shape, assigning stable ids. */
  private toVariantGroups(
    dtos?: VariantGroupDto[],
  ): ProductVariantGroup[] | undefined {
    if (dtos === undefined) return undefined;
    return dtos.map((g) => ({
      id: g.id || shortId(),
      name: g.name.trim(),
      options: g.options.map((o) => ({
        id: o.id || shortId(),
        label: o.label.trim(),
        priceDeltaCents:
          o.priceDelta !== undefined ? dollarsToCents(o.priceDelta) : 0,
      })),
    }));
  }

  /** Normalize pack DTOs to storage shape, assigning stable ids. */
  private toPacks(dtos?: PackDto[]): ProductPack[] | undefined {
    if (dtos === undefined) return undefined;
    return dtos.map((p) => ({
      id: p.id || shortId(),
      label: p.label?.trim() ?? '',
      units: p.units,
      priceCents: dollarsToCents(p.price),
    }));
  }

  /** Public catalog listing for a storefront, optionally filtered by category. */
  async listByHandle(
    handle: string,
    cat?: string,
  ): Promise<{
    shop: ShopResponse;
    products: ProductResponse[];
    combos: ComboResponse[];
  }> {
    const shop = await this.shops.requireLiveByHandle(handle);
    const filterByCat = cat && cat.toLowerCase() !== 'all';
    const [rows, shopCombos] = await Promise.all([
      this.db.query.products.findMany({
        where: filterByCat
          ? and(eq(products.shopId, shop.id), eq(products.cat, cat))
          : eq(products.shopId, shop.id),
        orderBy: [desc(products.createdAt)],
      }),
      this.combos.publicForShop(shop.id),
    ]);
    return {
      shop: ShopResponse.fromRow(shop),
      products: rows.map(ProductResponse.fromRow),
      combos: shopCombos,
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
    const [productReviews, productCombos] = await Promise.all([
      this.db.query.reviews.findMany({
        where: eq(reviews.productId, product.id),
        orderBy: [desc(reviews.createdAt)],
      }),
      this.combos.publicForProduct(shop.id, product.id),
    ]);
    return ProductDetailResponse.fromRows(
      product,
      productReviews,
      productCombos,
    );
  }

  async create(
    shopId: string,
    dto: CreateProductDto,
  ): Promise<ProductResponse> {
    const shop = await this.shops.requireById(shopId);
    // Free-plan shops carry a hard catalog limit until they subscribe.
    if (shop.plan === 'free') {
      const [{ n }] = await this.db
        .select({ n: count() })
        .from(products)
        .where(eq(products.shopId, shopId));
      if (Number(n) >= FREE_MAX_PRODUCTS) {
        throw new ForbiddenException(
          `The free plan allows ${FREE_MAX_PRODUCTS} product — subscribe to add more.`,
        );
      }
    } else {
      // A cancelled subscription freezes the catalog: the existing items are
      // kept, but nothing new can be added until the seller resumes.
      const sub = await this.db.query.subscriptions.findFirst({
        where: eq(subscriptions.shopId, shopId),
        columns: { status: true },
      });
      if (sub?.status === 'cancelled') {
        throw new ForbiddenException(
          'Your subscription is cancelled — resume it to add new products.',
        );
      }
    }
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
        // 0 (or absent) means "no compare-at price" — stored as null.
        comparePriceCents: dto.comparePrice
          ? dollarsToCents(dto.comparePrice)
          : null,
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
        videoUrl: dto.videoUrl || null,
        variantGroups: this.toVariantGroups(dto.variantGroups),
        packs: this.toPacks(dto.packs),
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
        : ((await this.storage.absorbMany(dto.images, 'products')) ??
          undefined);
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
      // Present-but-empty clears the video; absent leaves it unchanged.
      videoUrl: dto.videoUrl === undefined ? undefined : dto.videoUrl || null,
      // Replace-on-present semantics.
      variantGroups: this.toVariantGroups(dto.variantGroups),
      packs: this.toPacks(dto.packs),
    };
    if (dto.price !== undefined) {
      patch.priceCents = dollarsToCents(dto.price);
    }
    // Present clears (0) or sets the compare-at price; absent leaves it as-is.
    if (dto.comparePrice !== undefined) {
      patch.comparePriceCents = dto.comparePrice
        ? dollarsToCents(dto.comparePrice)
        : null;
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
