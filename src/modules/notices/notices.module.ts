import { Module } from '@nestjs/common';
import { ShopsModule } from '../shops/shops.module';
import { NoticesController } from './notices.controller';
import { NoticesService } from './notices.service';
import { PlatformNoticesController } from './platform-notices.controller';

/**
 * Platform-to-seller announcements: the operator publishes banners (global
 * or targeted at one shop) that appear at the top of seller admin consoles.
 */
@Module({
  imports: [ShopsModule],
  controllers: [NoticesController, PlatformNoticesController],
  providers: [NoticesService],
  // The platform console's shop drawer messages one seller through this.
  exports: [NoticesService],
})
export class NoticesModule {}
