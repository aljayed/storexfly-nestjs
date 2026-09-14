import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CombosModule } from '../combos/combos.module';
import { ShopsModule } from '../shops/shops.module';
import { ItemAiController } from './item-ai.controller';
import { ItemAiService } from './item-ai.service';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { SeoController } from './seo.controller';
import { ShareController } from './share.controller';

@Module({
  imports: [ShopsModule, AuthModule, CombosModule],
  controllers: [ProductsController, ShareController, SeoController, ItemAiController],
  providers: [ProductsService, ItemAiService],
  exports: [ProductsService],
})
export class ProductsModule {}
