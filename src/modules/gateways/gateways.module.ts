import { Module } from '@nestjs/common';
import { BkashService } from './bkash.service';
import { CarrybeeService } from './carrybee.service';
import { CourierSettingsService } from './courier-settings.service';
import { GatewaySettingsService } from './gateway-settings.service';
import { PathaoService } from './pathao.service';
import { ShopCourierStoresService } from './shop-courier-stores.service';
import { SteadfastService } from './steadfast.service';

/**
 * External money/logistics integrations: bKash Tokenized Checkout plus the
 * CarryBee, Steadfast and Pathao couriers. Every one of them runs on the
 * platform's own merchant credentials (see CourierSettingsService), so a shop
 * cannot route money or parcels around the platform. What is per-shop is
 * where the rider collects: ShopCourierStoresService registers a pickup store
 * for each seller under that one account.
 *
 * Deliberately controller-free so any module can import it without route side
 * effects (orders drive booking, the platform console drives configuration).
 */
@Module({
  providers: [
    GatewaySettingsService,
    CourierSettingsService,
    BkashService,
    CarrybeeService,
    SteadfastService,
    PathaoService,
    ShopCourierStoresService,
  ],
  exports: [
    GatewaySettingsService,
    CourierSettingsService,
    BkashService,
    CarrybeeService,
    SteadfastService,
    PathaoService,
    ShopCourierStoresService,
  ],
})
export class GatewaysModule {}
