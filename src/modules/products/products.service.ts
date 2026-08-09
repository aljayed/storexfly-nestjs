import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { and, asc, desc, eq } from 'drizzle-orm';
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
  type ProductVariantCombination,
  type ProductVariantGroup,
} from '../../database/schema';
import { StorageService } from '../storage/storage.service';
import { ShopsService } from '../shops/shops.service';
import { CombosService } from '../combos/combos.service';
import { ComboResponse } from '../combos/dto/combo.response';
import type {
  CreateProductDto,
  PackDto,
  VariantCombinationDto,
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

  /** Lowest enabled exact row drives the catalog's “starting at” price. */
  private catalogCombination(
    combinations: ProductVariantCombination[],
  ): ProductVariantCombination | undefined {
    const available = combinations.filter((c) => c.available);
    return [...(available.length ? available : combinations)].sort(
      (a, b) => a.priceCents - b.priceCents,
    )[0];
  }

  /**
   * The product-level `stock` column for an exact-row product: what a buyer
   * could actually order across every sellable row. Checkout recomputes it the
   * same way, so the column and the rows can never tell different stories.
   */
  private combinationStock(combinations: ProductVariantCombination[]): number {
    return combinations.reduce(
      (sum, c) => sum + (c.available ? c.stock : 0),
      0,
    );
  }

  /**
   * The legacy per-option model expresses “not every pairing exists” through
   * `onlyWith`, which only ever meant *the other* group - a third group would
   * silently drop every restriction the seller had set (see `settleOnlyWith`).
   * Exact rows say it directly, so that is the way past two groups.
   */
  private assertGroupLimit(
    groups: ProductVariantGroup[],
    combinations: ProductVariantCombination[],
  ): void {
    if (groups.length > 2 && !combinations.length) {
      throw new BadRequestException(
        'A third option group needs exact variant rows - switch this item to exact variants first.',
      );
    }
  }

  /**
   * Normalize variant-group DTOs to storage shape, assigning stable ids.
   * Option photos go through the same absorb step as the gallery, so a
   * freshly-picked base64 image is uploaded once and only its URL is stored;
   * an already-absorbed `/media` URL passes straight through.
   */
  private async toVariantGroups(
    dtos?: VariantGroupDto[],
  ): Promise<ProductVariantGroup[] | undefined> {
    if (dtos === undefined) return undefined;
    const groups = await Promise.all(
      dtos.map(async (g) => ({
        id: g.id || shortId(),
        name: g.name.trim(),
        options: await Promise.all(
          g.options.map(async (o) => ({
            id: o.id || shortId(),
            label: o.label.trim(),
            priceDeltaCents:
              o.priceDelta !== undefined ? dollarsToCents(o.priceDelta) : 0,
            // '' clears a previously-set photo; absent leaves it unset.
            image: o.image
              ? ((await this.storage.absorb(o.image, 'products')) ?? null)
              : null,
            // Undefined and null both mean "don't track this option".
            stock: o.stock ?? null,
            onlyWith: o.onlyWith ?? null,
          })),
        ),
      })),
    );
    const groupIds = new Set<string>();
    const groupNames = new Set<string>();
    for (const group of groups) {
      const groupName = group.name.toLocaleLowerCase();
      if (!group.name || groupIds.has(group.id) || groupNames.has(groupName)) {
        throw new BadRequestException(
          'Option groups need unique names and stable ids.',
        );
      }
      groupIds.add(group.id);
      groupNames.add(groupName);
      const ids = new Set<string>();
      const labels = new Set<string>();
      for (const option of group.options) {
        const label = option.label.toLocaleLowerCase();
        if (!option.label || ids.has(option.id) || labels.has(label)) {
          throw new BadRequestException(
            `Choices in “${group.name}” need unique names and ids.`,
          );
        }
        ids.add(option.id);
        labels.add(label);
      }
    }
    return this.settleOnlyWith(groups);
  }

  /**
   * Second pass over the saved groups: `onlyWith` points at option ids in the
   * *other* group, which only makes sense once both groups have their ids.
   *
   * Anything dangling is dropped rather than rejected - an id can legitimately
   * disappear when the seller deletes an option in the same save, and a stale
   * reference must not be allowed to make a colour unbuyable. A list that ends
   * up covering every option (or nothing at all) means "no restriction", and
   * is stored as null so the storefront has one case to read, not three.
   */
  private settleOnlyWith(groups: ProductVariantGroup[]): ProductVariantGroup[] {
    return groups.map((g, i) => {
      const other = groups.length === 2 ? groups[1 - i] : undefined;
      const validIds = new Set(other?.options.map((o) => o.id) ?? []);
      return {
        ...g,
        options: g.options.map((o) => {
          const kept = (o.onlyWith ?? []).filter((id) => validIds.has(id));
          return {
            ...o,
            onlyWith:
              kept.length === 0 || kept.length === validIds.size ? null : kept,
          };
        }),
      };
    });
  }

  /** Normalize and validate exact sellable combinations against the groups. */
  private async toVariantCombinations(
    dtos: VariantCombinationDto[] | undefined,
    groups: ProductVariantGroup[],
  ): Promise<ProductVariantCombination[] | undefined> {
    if (dtos === undefined) return undefined;
    if (!groups.length) {
      if (dtos.length) {
        throw new BadRequestException(
          'Variant combinations require at least one option group.',
        );
      }
      return [];
    }

    // An empty array deliberately opts an existing product into the legacy
    // model. Once exact rows are supplied, every cartesian pick must have a
    // row; unavailable combinations stay explicit with `available: false`.
    if (dtos.length) {
      const optionIds = groups.flatMap((group) =>
        group.options.map((option) => option.id),
      );
      if (new Set(optionIds).size !== optionIds.length) {
        throw new BadRequestException(
          'Exact variant choices need unique ids across every option group.',
        );
      }
      const expected = groups.reduce(
        (count, group) => count * group.options.length,
        1,
      );
      if (dtos.length !== expected) {
        throw new BadRequestException(
          `Expected ${expected} exact variant combinations, received ${dtos.length}.`,
        );
      }
    }

    const seenPicks = new Set<string>();
    const seenIds = new Set<string>();
    const seenSkus = new Set<string>();
    return Promise.all(
      dtos.map(async (c) => {
        const optionIds: Record<string, string> = {};
        for (const group of groups) {
          const optionId = c.optionIds?.[group.id];
          if (
            typeof optionId !== 'string' ||
            !group.options.some((o) => o.id === optionId)
          ) {
            throw new BadRequestException(
              `Every variant combination must choose a valid “${group.name}” option.`,
            );
          }
          optionIds[group.id] = optionId;
        }
        if (Object.keys(c.optionIds ?? {}).length !== groups.length) {
          throw new BadRequestException(
            'A variant combination contains an unknown option group.',
          );
        }
        const key = groups.map((g) => `${g.id}:${optionIds[g.id]}`).join('|');
        if (seenPicks.has(key)) {
          throw new BadRequestException('Variant combinations must be unique.');
        }
        seenPicks.add(key);

        const id = c.id || shortId();
        if (seenIds.has(id)) {
          throw new BadRequestException(
            'Variant combination ids must be unique.',
          );
        }
        seenIds.add(id);
        if (c.comparePrice && c.comparePrice <= c.price) {
          throw new BadRequestException(
            'A variant compare-at price must be higher than its selling price.',
          );
        }
        const sku = c.sku?.trim() || null;
        const normalizedSku = sku?.toLocaleLowerCase();
        if (normalizedSku && seenSkus.has(normalizedSku)) {
          throw new BadRequestException('Variant SKUs must be unique.');
        }
        if (normalizedSku) seenSkus.add(normalizedSku);
        return {
          id,
          optionIds,
          priceCents: dollarsToCents(c.price),
          comparePriceCents: c.comparePrice
            ? dollarsToCents(c.comparePrice)
            : null,
          stock: c.stock,
          image: c.image
            ? ((await this.storage.absorb(c.image, 'products')) ?? null)
            : null,
          sku,
          available: c.available ?? true,
        };
      }),
    );
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

  /** Public product page - product + reviews + rating distribution. */
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
    await this.shops.requireById(shopId);
    // The catalog itself is never capped - a shop pays for the selling it
    // does, not for the listings it keeps. A cancelled subscription still
    // freezes it: the existing items are kept, but nothing new can be added
    // until the seller resumes.
    const sub = await this.db.query.subscriptions.findFirst({
      where: eq(subscriptions.shopId, shopId),
      columns: { status: true },
    });
    if (sub?.status === 'cancelled') {
      throw new ForbiddenException(
        'Your subscription is cancelled - resume it to add new products.',
      );
    }
    const slug = await this.uniqueSlug(shopId, dto.name);
    // Showcase items can't be ordered online, so stock is meaningless for
    // them - pin it to 0 regardless of what the caller sends.
    const listingType = dto.listingType ?? 'sale';
    // Upload any inline base64 photos to object storage, keeping only the URLs.
    const images = await this.storage.absorbMany(dto.images, 'products');
    const variantGroups = (await this.toVariantGroups(dto.variantGroups)) ?? [];
    const variantCombinations =
      (await this.toVariantCombinations(
        dto.variantCombinations,
        variantGroups,
      )) ?? [];
    this.assertGroupLimit(variantGroups, variantCombinations);
    const catalogCombination = this.catalogCombination(variantCombinations);
    const [row] = await this.db
      .insert(products)
      .values({
        shopId,
        name: dto.name,
        slug,
        cat: dto.cat,
        listingType,
        priceCents: catalogCombination?.priceCents ?? dollarsToCents(dto.price),
        // 0 (or absent) means "no compare-at price" - stored as null.
        comparePriceCents: catalogCombination
          ? (catalogCombination.comparePriceCents ?? null)
          : dto.comparePrice
            ? dollarsToCents(dto.comparePrice)
            : null,
        unit: dto.unit,
        stock:
          listingType === 'showcase'
            ? 0
            : variantCombinations.length
              ? this.combinationStock(variantCombinations)
              : (dto.stock ?? 0),
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
        variantGroups,
        variantCombinations,
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
    const variantGroups = await this.toVariantGroups(dto.variantGroups);
    const combinationGroups = variantGroups ?? current.variantGroups ?? [];
    const variantCombinations = await this.toVariantCombinations(
      dto.variantCombinations,
      combinationGroups,
    );
    // Replacing the groups without sending rows drops the matrix: the rows on
    // file point at option ids that may not exist any more.
    const nextCombinations =
      dto.variantGroups !== undefined && dto.variantCombinations === undefined
        ? []
        : variantCombinations;
    // What the row will hold once this patch lands. Price and stock are read
    // off *this*, not off the DTO, so a partial update that never mentions
    // variants can't leave the columns disagreeing with the rows.
    const effective = nextCombinations ?? current.variantCombinations ?? [];
    this.assertGroupLimit(combinationGroups, effective);
    const catalogCombination = this.catalogCombination(effective);
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
      variantGroups,
      variantCombinations: nextCombinations,
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
    if (catalogCombination) {
      patch.priceCents = catalogCombination.priceCents;
      patch.comparePriceCents = catalogCombination.comparePriceCents ?? null;
    }
    if (dto.deliveryDhaka !== undefined) {
      patch.deliveryDhakaCents = dollarsToCents(dto.deliveryDhaka);
    }
    if (dto.deliveryOutside !== undefined) {
      patch.deliveryOutsideCents = dollarsToCents(dto.deliveryOutside);
    }
    if (effective.length) {
      patch.stock = this.combinationStock(effective);
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
