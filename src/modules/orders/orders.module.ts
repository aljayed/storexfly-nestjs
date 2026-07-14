import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { SettlementsModule } from '../settlements/settlements.module';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

@Module({
  imports: [CustomersModule, SettlementsModule],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
