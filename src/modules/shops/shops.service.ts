import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, ne } from 'drizzle-orm';
import { BRAND_SWATCHES } from '../../common/constants/brand-swatches';
import { handleize } from '../../common/utils/slug.util';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import {
  products,
  shops,
  type ShopRow,
} from '../../database/schema';
import { ProductResponse } from '../products/dto/product.response';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import type { CreateShopDto } from './dto/create-shop.dto';
import { ShopResponse } from './dto/shop.response';
import type { UpdateShopDto } from './dto/update-shop.dto';

const FEATURED_LIMIT = 8;

@Injectable()
export class ShopsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly subscriptions: SubscriptionsService,
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
      })
      .returning();
    // Consume the paid credit and open the monthly subscription.
    await this.subscriptions.activateForNewShop(ownerId, row.id);
    return ShopResponse.fromRow(row);
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
    const patch: Partial<ShopRow> = {
      name: dto.name ?? undefined,
      tagline: dto.tagline ?? undefined,
      cat: dto.cat ?? undefined,
      currency: dto.currency ?? undefined,
    };
    if (dto.brandId) {
      const swatch = BRAND_SWATCHES[dto.brandId];
      patch.brandId = dto.brandId;
      patch.brand = swatch.c;
      patch.brandSoft = swatch.soft;
    }
    const [row] = await this.db
      .update(shops)
      .set(patch)
      .where(eq(shops.id, id))
      .returning();
    return ShopResponse.fromRow(row);
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
