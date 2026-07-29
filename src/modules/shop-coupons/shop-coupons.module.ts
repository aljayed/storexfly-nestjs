import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ShopsModule } from '../shops/shops.module';
import { ShopCouponsController } from './shop-coupons.controller';
import { ShopCouponsService } from './shop-coupons.service';

/**
 * Shop-owned discount codes for buyers. Exported because the checkout flow
 * (OrdersModule) evaluates and redeems a code inside its own transaction.
 */
@Module({
  imports: [ShopsModule, AuthModule],
  controllers: [ShopCouponsController],
  providers: [ShopCouponsService],
  exports: [ShopCouponsService],
})
export class ShopCouponsModule {}
