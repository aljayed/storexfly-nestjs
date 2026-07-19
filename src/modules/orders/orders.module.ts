import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { GatewaysModule } from '../gateways/gateways.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SettlementsModule } from '../settlements/settlements.module';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

@Module({
  imports: [
    CustomersModule,
    SettlementsModule,
    GatewaysModule,
    NotificationsModule,
  ],
  controllers: [OrdersController, PaymentsController],
  providers: [OrdersService, PaymentsService],
  exports: [OrdersService],
})
export class OrdersModule {}
