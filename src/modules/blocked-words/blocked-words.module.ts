import { Module } from '@nestjs/common';
import { BlockedWordsService } from './blocked-words.service';

/**
 * Shared across the platform-admin console (CRUD) and every module that
 * validates user-supplied names (shops, seller/buyer signup).
 */
@Module({
  providers: [BlockedWordsService],
  exports: [BlockedWordsService],
})
export class BlockedWordsModule {}
