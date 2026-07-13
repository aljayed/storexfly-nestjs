import { Module } from '@nestjs/common';
import { ShopsModule } from '../shops/shops.module';
import { FeesController } from './fees.controller';
import { FeesService } from './fees.service';
import { PlatformSettlementsController } from './platform-settlements.controller';
import { SettlementsController } from './settlements.controller';
import { SettlementsService } from './settlements.service';

/**
 * Monthly payout accounting for prepaid orders: the seller-facing breakdown
 * (per shop), the platform-operator console that records the payouts, and
 * the platform-configurable gateway fee rates the math runs on.
 */
@Module({
  imports: [ShopsModule],
  controllers: [
    SettlementsController,
    PlatformSettlementsController,
    FeesController,
  ],
  providers: [SettlementsService, FeesService],
})
export class SettlementsModule {}
