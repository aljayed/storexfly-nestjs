import { Module } from '@nestjs/common';
import { ShopsModule } from '../shops/shops.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  imports: [ShopsModule],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
