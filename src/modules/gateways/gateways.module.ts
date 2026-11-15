import { Module } from '@nestjs/common';
import { BkashService } from './bkash.service';
import { CarrybeeService } from './carrybee.service';
import { CourierSettingsService } from './courier-settings.service';
import { GatewayCheckoutService } from './gateway-checkout.service';
import { GatewaySettingsService } from './gateway-settings.service';
import { ShopCourierStoresService } from './shop-courier-stores.service';
import { SslcommerzService } from './sslcommerz.service';

/**
 * External money/logistics integrations: the bKash and SSLCommerz hosted
 * checkouts plus the CarryBee courier. Every one of
 * them runs on the platform's own merchant credentials (see
 * GatewaySettingsService, CourierSettingsService), so a shop cannot route
 * money or parcels around the platform. What is per-shop is
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
    SslcommerzService,
    GatewayCheckoutService,
    CarrybeeService,
    ShopCourierStoresService,
  ],
  exports: [
    GatewaySettingsService,
    CourierSettingsService,
    BkashService,
    SslcommerzService,
    GatewayCheckoutService,
    CarrybeeService,
    ShopCourierStoresService,
  ],
})
export class GatewaysModule {}
