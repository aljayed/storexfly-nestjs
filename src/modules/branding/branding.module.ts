import { Module } from '@nestjs/common';
import { BrandingService } from './branding.service';

/**
 * Platform branding (the text-based logo wordmark). The service is exported for
 * the platform-admin module, which exposes the public read + operator update.
 */
@Module({
  providers: [BrandingService],
  exports: [BrandingService],
})
export class BrandingModule {}
