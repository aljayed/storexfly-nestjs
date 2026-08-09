import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ChatModule } from '../chat/chat.module';
import { CustomersModule } from '../customers/customers.module';
import { GatewaysModule } from '../gateways/gateways.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SettlementsModule } from '../settlements/settlements.module';
import { ShopCouponsModule } from '../shop-coupons/shop-coupons.module';
import { CourierWebhookController } from './courier-webhook.controller';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { PaymentsController } from './payments.controller';
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
  ],
  controllers: [OrdersController, PaymentsController, CourierWebhookController],
  providers: [OrdersService, PaymentsService],
  exports: [OrdersService],
})
export class OrdersModule {}
