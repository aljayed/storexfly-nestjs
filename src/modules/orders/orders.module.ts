import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ChatModule } from '../chat/chat.module';
import { CustomersModule } from '../customers/customers.module';
import { GatewaysModule } from '../gateways/gateways.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SettlementsModule } from '../settlements/settlements.module';
import { ShopCouponsModule } from '../shop-coupons/shop-coupons.module';
import { ShopsModule } from '../shops/shops.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { CourierWebhookController } from './courier-webhook.controller';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { PaymentsController } from './payments.controller';
import { RefundsService } from './refunds.service';
import { PaymentsService } from './payments.service';

@Module({
  imports: [
    JwtModule.register({}),
    CustomersModule,
    SettlementsModule,
    GatewaysModule,
    NotificationsModule,
    ChatModule,
    ShopCouponsModule,
    // The return leg settles credit-pack purchases as well as orders, and
    // opens the shop a seller has just paid the opening pack for.
    SubscriptionsModule,
    ShopsModule,
  ],
  controllers: [OrdersController, PaymentsController, CourierWebhookController],
  providers: [OrdersService, PaymentsService, RefundsService],
  exports: [OrdersService, RefundsService],
})
export class OrdersModule {}
