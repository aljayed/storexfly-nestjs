import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import {
  CommerceAdminController,
  CommerceBuyerController,
  CommercePublicController,
  CommercePlatformController,
} from './commerce.controller';
import { CommerceService } from './commerce.service';
@Module({
  imports: [AuthModule],
  controllers: [
    CommercePublicController,
    CommerceBuyerController,
    CommerceAdminController,
    CommercePlatformController,
  ],
  providers: [CommerceService],
  exports: [CommerceService],
})
export class CommerceModule {}
