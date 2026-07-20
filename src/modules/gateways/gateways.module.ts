import { Module } from '@nestjs/common';
import { BkashService } from './bkash.service';
import { GatewaySettingsService } from './gateway-settings.service';
import { PathaoService } from './pathao.service';
import { ShopCourierSettingsService } from './shop-courier-settings.service';
import { SteadfastService } from './steadfast.service';

/**
 * External money/logistics integrations: bKash Tokenized Checkout (platform
 * credentials) plus Steadfast and Pathao couriers (per-shop credentials).
 * Deliberately controller-free so any module can import it without route
 * side effects (orders drive booking, shops drive configuration).
 */
@Module({
  providers: [
    GatewaySettingsService,
    ShopCourierSettingsService,
    BkashService,
    SteadfastService,
    PathaoService,
  ],
  exports: [
    GatewaySettingsService,
    ShopCourierSettingsService,
    BkashService,
    SteadfastService,
    PathaoService,
  ],
})
export class GatewaysModule {}
