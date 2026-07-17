import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { BRAND_SWATCHES } from '../../common/constants/brand-swatches';
import { centsToDollars } from '../../common/utils/money.util';
import { handleize } from '../../common/utils/slug.util';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import {
  products,
  shops,
  type ShopRow,
} from '../../database/schema';
import { BlockedWordsService } from '../blocked-words/blocked-words.service';
import { StorageService } from '../storage/storage.service';
import { ProductResponse } from '../products/dto/product.response';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import type { CreateShopDto } from './dto/create-shop.dto';
import type { SubmitKycDto } from './dto/kyc.dto';
import { KycResponse } from './dto/kyc.response';
import { ShopResponse } from './dto/shop.response';
import { DiscoverResponse } from './dto/discover.response';
import type { UpdateShopDto } from './dto/update-shop.dto';

const FEATURED_LIMIT = 8;
// Cards per section on the public marketplace feed (logged-in no-shop home).
const DISCOVER_LIMIT = 12;

@Injectable()
export class ShopsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly subscriptions: SubscriptionsService,
    private readonly blockedWords: BlockedWordsService,
    private readonly storage: StorageService,
  ) {}

  /** Live handle availability check for the onboarding wizard. */
  async checkHandle(handle: string): Promise<{ available: boolean }> {
    const normalized = handleize(handle);
    if (!normalized) {
      return { available: false };
    }
    const existing = await this.db.query.shops.findFirst({
      where: eq(shops.handle, normalized),
      columns: { id: true },
    });
    return { available: !existing };
  }

  async create(ownerId: string, dto: CreateShopDto): Promise<ShopResponse> {
    // Every shop costs ৳1,199 up front — refuse until the fee is paid.
    if (!(await this.subscriptions.hasUnconsumedCredit(ownerId))) {
      throw new HttpException(
        {
          statusCode: HttpStatus.PAYMENT_REQUIRED,
          error: 'PaymentRequired',
          message: 'Pay the ৳1,199 shop fee before creating a shop.',
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
    const handle = handleize(dto.handle);
    await this.blockedWords.assertClean(dto.name);
    await this.blockedWords.assertClean(handle);
    const taken = await this.db.query.shops.findFirst({
      where: eq(shops.handle, handle),
      columns: { id: true },
    });
    if (taken) {
      throw new ForbiddenException('That handle is already taken');
    }
    const swatch = BRAND_SWATCHES[dto.brandId];
    const [row] = await this.db
      .insert(shops)
      .values({
        name: dto.name,
        handle,
        tagline: dto.tagline,
        cat: dto.cat,
        brandId: dto.brandId,
        brand: swatch.c,
        brandSoft: swatch.soft,
        ownerId,
        // Optional KYC supplied during onboarding — skipped sellers start
        // 'unsubmitted' (the column default).
        ...this.kycPatch(dto.kyc),
      })
      .returning();
    // Consume the paid credit and open the monthly subscription.
    await this.subscriptions.activateForNewShop(ownerId, row.id);
    return ShopResponse.fromRow(row);
  }

  /**
   * Public marketplace feed — live shops plus the newest products across
   * them, for buyers browsing outside any single storefront. Only the cover
   * image travels per product; the full data-URL arrays would put megabytes
   * on what should be a light feed.
   */
  async discover(): Promise<DiscoverResponse> {
    const [shopRows, productRows] = await Promise.all([
      this.db.query.shops.findMany({
        where: eq(shops.live, true),
        orderBy: [desc(shops.createdAt)],
        limit: DISCOVER_LIMIT,
        columns: {
          name: true,
          handle: true,
          tagline: true,
          cat: true,
          brand: true,
          brandSoft: true,
        },
      }),
      this.db
        .select({
          name: products.name,
          slug: products.slug,
          listingType: products.listingType,
          priceCents: products.priceCents,
          unit: products.unit,
          stock: products.stock,
          emoji: products.emoji,
          tone: products.tone,
          tag: products.tag,
          rating: products.rating,
          reviews: products.reviewsCount,
          image: sql<string | null>`(${products.images})[1]`,
          shopHandle: shops.handle,
          shopName: shops.name,
          currency: shops.currency,
        })
        .from(products)
        .innerJoin(shops, eq(products.shopId, shops.id))
        .where(eq(shops.live, true))
        .orderBy(desc(products.createdAt))
        .limit(DISCOVER_LIMIT),
    ]);
    return {
      shops: shopRows.map((s) => ({ ...s, tagline: s.tagline ?? undefined })),
      products: productRows.map((p) => ({
        name: p.name,
        slug: p.slug,
        listingType: p.listingType,
        price: centsToDollars(p.priceCents),
        unit: p.unit,
        stock: p.stock,
        emoji: p.emoji,
        tone: p.tone,
        tag: p.tag ?? undefined,
        rating: p.rating,
        reviews: p.reviews,
        image: p.image ?? undefined,
        shopHandle: p.shopHandle,
        shopName: p.shopName,
        currency: p.currency,
      })),
    };
  }

  /** Public storefront load — shop + a slice of featured products. */
  async getByHandle(handle: string): Promise<{
    shop: ShopResponse;
    featured: ProductResponse[];
  }> {
    const shop = await this.requireLiveByHandle(handle);
    const featured = await this.db.query.products.findMany({
      where: eq(products.shopId, shop.id),
      orderBy: [desc(products.rating), desc(products.reviewsCount)],
      limit: FEATURED_LIMIT,
    });
    return {
      shop: ShopResponse.fromRow(shop),
      featured: featured.map(ProductResponse.fromRow),
    };
  }

  async getById(id: string): Promise<ShopResponse> {
    return ShopResponse.fromRow(await this.requireById(id));
  }

  async update(
    ownerId: string,
    id: string,
    dto: UpdateShopDto,
  ): Promise<ShopResponse> {
    const shop = await this.requireById(id);
    if (shop.ownerId !== ownerId) {
      throw new ForbiddenException('You do not own this shop');
    }
    if (dto.name) {
      await this.blockedWords.assertClean(dto.name);
    }
    const patch: Partial<ShopRow> = {
      name: dto.name ?? undefined,
      tagline: dto.tagline ?? undefined,
      cat: dto.cat ?? undefined,
      currency: dto.currency ?? undefined,
      language: dto.language ?? undefined,
    };
    // Support contacts: an empty string clears the saved value.
    if (dto.supportEmail !== undefined) {
      patch.supportEmail = dto.supportEmail.trim() || null;
    }
    if (dto.supportPhone !== undefined) {
      patch.supportPhone = dto.supportPhone.trim() || null;
    }
    if (dto.brandId) {
      const swatch = BRAND_SWATCHES[dto.brandId];
      patch.brandId = dto.brandId;
      patch.brand = swatch.c;
      patch.brandSoft = swatch.soft;
    }
    // Banners are replace-all: an empty array clears them; null keeps the column
    // tidy when there are none left. Newly-added base64 images are uploaded to
    // object storage first; existing /media URLs pass through unchanged.
    if (dto.bannerImages !== undefined) {
      const banners = dto.bannerImages.map((b) => b.trim()).filter(Boolean);
      const uploaded = await this.storage.absorbMany(banners, 'shops');
      patch.bannerImages = uploaded && uploaded.length ? uploaded : null;
    }
    if (dto.floatingImages !== undefined) {
      const floats = dto.floatingImages.map((b) => b.trim()).filter(Boolean);
      const uploaded = await this.storage.absorbMany(floats, 'shops');
      patch.floatingImages = uploaded && uploaded.length ? uploaded : null;
    }
    const [row] = await this.db
      .update(shops)
      .set(patch)
      .where(eq(shops.id, id))
      .returning();
    return ShopResponse.fromRow(row);
  }

  /** Owner-only read of the full KYC record (includes the trade licence). */
  async getKyc(ownerId: string, id: string): Promise<KycResponse> {
    const shop = await this.requireById(id);
    if (shop.ownerId !== ownerId) {
      throw new ForbiddenException('You do not own this shop');
    }
    return KycResponse.fromRow(shop);
  }

  /**
   * Create or update the shop's business verification. Sellers can save
   * partial details and finish later; submitting (or replacing) the document
   * moves the shop into the 'pending' review state. Already-verified shops
   * keep their status when only the editable text fields change.
   */
  async submitKyc(
    ownerId: string,
    id: string,
    dto: SubmitKycDto,
  ): Promise<KycResponse> {
    const shop = await this.requireById(id);
    if (shop.ownerId !== ownerId) {
      throw new ForbiddenException('You do not own this shop');
    }
    const patch = this.kycPatch(dto, shop);
    if (Object.keys(patch).length === 0) {
      return KycResponse.fromRow(shop);
    }
    const [row] = await this.db
      .update(shops)
      .set(patch)
      .where(eq(shops.id, id))
      .returning();
    return KycResponse.fromRow(row);
  }

  /**
   * Build the KYC column patch from a (partial) submission. `current` is the
   * existing shop on an update (absent during onboarding).
   *
   * A submission (re)enters the operator's 'pending' review queue when either:
   *  - a fresh document is uploaded, or
   *  - a previously *rejected* shop resubmits — even with no new file — so the
   *    operator sees it again and the seller isn't stuck on 'rejected'.
   * A *verified* shop keeps its badge on text-only edits (only a new document
   * sends it back for review). Returns an empty object when nothing was given.
   */
  private kycPatch(dto?: SubmitKycDto, current?: ShopRow): Partial<ShopRow> {
    if (!dto) return {};
    const patch: Partial<ShopRow> = {};
    if (dto.legalName !== undefined) {
      patch.kycLegalName = dto.legalName.trim() || null;
    }
    if (dto.licenseNo !== undefined) {
      patch.kycLicenseNo = dto.licenseNo.trim() || null;
    }

    const hasNewDoc = dto.document !== undefined;
    if (hasNewDoc) {
      patch.kycDocument = dto.document!.trim() || null;
    }

    // A document must be on file for there to be anything to review — either
    // the one just uploaded, or the one already saved on a resubmission.
    const documentOnFile = hasNewDoc
      ? !!patch.kycDocument
      : !!current?.kycDocument;
    const resubmittingRejected = current?.kycStatus === 'rejected';
    if (documentOnFile && (hasNewDoc || resubmittingRejected)) {
      patch.kycStatus = 'pending';
      patch.kycSubmittedAt = new Date();
    }
    return patch;
  }

  async listForOwner(ownerId: string): Promise<ShopResponse[]> {
    const rows = await this.db.query.shops.findMany({
      where: eq(shops.ownerId, ownerId),
      orderBy: [desc(shops.createdAt)],
    });
    return rows.map(ShopResponse.fromRow);
  }

  // ── Internal helpers shared with other modules ───────────────
  async requireById(id: string): Promise<ShopRow> {
    const shop = await this.db.query.shops.findFirst({
      where: eq(shops.id, id),
    });
    if (!shop) {
      throw new NotFoundException('Shop not found');
    }
    return shop;
  }

  async requireByHandle(handle: string): Promise<ShopRow> {
    const shop = await this.db.query.shops.findFirst({
      where: eq(shops.handle, handleize(handle)),
    });
    if (!shop) {
      throw new NotFoundException('Shop not found');
    }
    return shop;
  }

  /**
   * Like `requireByHandle`, but for buyer-facing routes: a shop that has been
   * switched off is invisible to buyers. The `ShopOffline` error code lets
   * the storefront render a dedicated "temporarily closed" page.
   */
  async requireLiveByHandle(handle: string): Promise<ShopRow> {
    const shop = await this.requireByHandle(handle);
    if (!shop.live) {
      throw new HttpException(
        {
          statusCode: HttpStatus.FORBIDDEN,
          error: 'ShopOffline',
          message: 'This shop is currently offline.',
        },
        HttpStatus.FORBIDDEN,
      );
    }
    return shop;
  }

  /** True if `handle` is unused by any shop other than `exceptId`. */
  async isHandleFree(handle: string, exceptId?: string): Promise<boolean> {
    const normalized = handleize(handle);
    const existing = await this.db.query.shops.findFirst({
      where: exceptId
        ? and(eq(shops.handle, normalized), ne(shops.id, exceptId))
        : eq(shops.handle, normalized),
      columns: { id: true },
    });
    return !existing;
  }
}
