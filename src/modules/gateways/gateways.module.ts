import { Module } from '@nestjs/common';
import { BkashService } from './bkash.service';
import { GatewaySettingsService } from './gateway-settings.service';
import { SteadfastService } from './steadfast.service';

/**
 * External money/logistics integrations: bKash Tokenized Checkout and
 * Steadfast Courier, both configured from the platform-admin console.
 * Deliberately controller-free so any module can import it without route
 * side effects (orders drive checkout, platform drives configuration).
 */
@Module({
  providers: [GatewaySettingsService, BkashService, SteadfastService],
  exports: [GatewaySettingsService, BkashService, SteadfastService],
})
export class GatewaysModule {}
