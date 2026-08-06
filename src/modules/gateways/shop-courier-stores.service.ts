import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import {
  shopCourierStores,
  shops,
  type CourierProvider,
  type ShopRow,
} from '../../database/schema';
import { CarrybeeService, type CarrybeeConfig } from './carrybee.service';
import { PathaoService, type PathaoConfig } from './pathao.service';

/**
 * The courier pickup store each shop's parcels are collected from.
 *
 * This is a marketplace, so orders arrive from whichever seller made the sale
 * and every one of them ships from a different address. A platform-wide
 * pickup store would send a rider to one door for parcels sitting in a
 * hundred others, so each shop gets its own store - registered under the
 * operator's courier account, from the shop's own pickup address, the first
 * time it books a parcel.
 *
 * The credentials stay platform-held. Only the collection point is the
 * seller's, which is the part that was never the platform's to choose.
 */
@Injectable()
export class ShopCourierStoresService {
  private readonly logger = new Logger(ShopCourierStoresService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly carrybee: CarrybeeService,
    private readonly pathao: PathaoService,
  ) {}

  /**
   * The shop's store id for this provider, registering one if it has none.
   *
   * Steadfast never reaches here - it routes on the written address and has
   * no concept of a pickup store.
   */
  async resolve(
    shopId: string,
    provider: Extract<CourierProvider, 'carrybee' | 'pathao'>,
    config: CarrybeeConfig | PathaoConfig,
  ): Promise<string> {
    const existing = await this.db.query.shopCourierStores.findFirst({
      where: and(
        eq(shopCourierStores.shopId, shopId),
        eq(shopCourierStores.provider, provider),
      ),
    });
    if (existing) return existing.storeId;

    const shop = await this.db.query.shops.findFirst({
      where: eq(shops.id, shopId),
    });
    if (!shop) throw new BadRequestException('Shop not found');
    const pickup = this.requirePickup(shop);

    const storeId =
      provider === 'carrybee'
        ? await this.carrybee.createStore(config as CarrybeeConfig, {
            name: storeName(shop),
            contactPersonName: pickup.contactName,
            contactPersonNumber: pickup.phone,
            address: pickup.address,
            cityId: pickup.cityId,
            zoneId: pickup.zoneId,
            areaId: pickup.areaId,
          })
        : await this.pathao.createStore(config as PathaoConfig, {
            name: storeName(shop),
            contactName: pickup.contactName,
            contactNumber: pickup.phone,
            address: pickup.address,
            cityId: pickup.cityId,
            zoneId: pickup.zoneId,
            areaId: pickup.areaId,
          });

    // A duplicate insert means two bookings raced; the courier now holds two
    // identical stores, which is untidy but harmless, and both bookings must
    // agree on one. Keep whichever landed first.
    const [row] = await this.db
      .insert(shopCourierStores)
      .values({ shopId, provider, storeId })
      .onConflictDoNothing()
      .returning();
    if (row) {
      this.logger.log(
        `Registered ${provider} pickup store ${storeId} for shop ${shop.handle}`,
      );
      return row.storeId;
    }
    const winner = await this.db.query.shopCourierStores.findFirst({
      where: and(
        eq(shopCourierStores.shopId, shopId),
        eq(shopCourierStores.provider, provider),
      ),
    });
    return winner?.storeId ?? storeId;
  }

  /**
   * The shop's pickup address, or a refusal naming what is missing. A parcel
   * cannot be collected from an address nobody has given, and failing here
   * with a clear message beats a 422 from the courier.
   */
  private requirePickup(shop: ShopRow): {
    contactName: string;
    phone: string;
    address: string;
    cityId: number;
    zoneId: number;
    areaId: number;
  } {
    const phone = shop.pickupPhone?.trim() || shop.supportPhone?.trim();
    if (
      !shop.pickupAddress?.trim() ||
      !shop.pickupCityId ||
      !shop.pickupZoneId ||
      !shop.pickupAreaId ||
      !phone
    ) {
      throw new BadRequestException(
        'Add your pickup address in Settings before booking a courier - the rider needs somewhere to collect from.',
      );
    }
    return {
      // Falls back to the shop name: the courier only needs someone to ask
      // for at the door, and most sellers are their own warehouse.
      contactName: shop.pickupContactName?.trim() || shop.name,
      phone,
      address: shop.pickupAddress.trim(),
      cityId: shop.pickupCityId,
      zoneId: shop.pickupZoneId,
      areaId: shop.pickupAreaId,
    };
  }

  /** Forget a shop's store so the next booking registers a fresh one - used
   *  when the seller moves, since couriers do not let a store be re-addressed
   *  through the API. */
  async forget(shopId: string): Promise<void> {
    await this.db
      .delete(shopCourierStores)
      .where(eq(shopCourierStores.shopId, shopId));
  }
}

/** CarryBee caps a store name at 30 characters, and it is what their rider
 *  and support staff see - so the shop's own name, trimmed. */
function storeName(shop: ShopRow): string {
  return shop.name.trim().slice(0, 30) || shop.handle.slice(0, 30);
}
