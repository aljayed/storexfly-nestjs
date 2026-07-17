import { Global, Module } from '@nestjs/common';
import { MediaController } from './media.controller';
import { StorageService } from './storage.service';

/**
 * Object-storage for user-uploaded media. Global so any module's service can
 * inject {@link StorageService} without importing this module; also serves the
 * public `/media` proxy.
 */
@Global()
@Module({
  controllers: [MediaController],
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
