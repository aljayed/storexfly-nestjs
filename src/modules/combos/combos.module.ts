import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ShopsModule } from '../shops/shops.module';
import { CombosController } from './combos.controller';
import { CombosService } from './combos.service';

@Module({
  imports: [ShopsModule, AuthModule],
  controllers: [CombosController],
  providers: [CombosService],
  exports: [CombosService],
})
export class CombosModule {}
