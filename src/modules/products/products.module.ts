import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CombosModule } from '../combos/combos.module';
import { ShopsModule } from '../shops/shops.module';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { ShareController } from './share.controller';

@Module({
  imports: [ShopsModule, AuthModule, CombosModule],
  controllers: [ProductsController, ShareController],
  providers: [ProductsService],
  exports: [ProductsService],
})
export class ProductsModule {}
