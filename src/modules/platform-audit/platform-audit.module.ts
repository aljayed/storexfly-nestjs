import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { PlatformAuditInterceptor } from './platform-audit.interceptor';
import { PlatformAuditService } from './platform-audit.service';

/**
 * The platform console's audit trail. Global so the platform guard (used by
 * controllers across many modules) can record refused attempts, and so every
 * module's platform routes are covered by the one interceptor.
 */
@Global()
@Module({
  providers: [
    PlatformAuditService,
    { provide: APP_INTERCEPTOR, useClass: PlatformAuditInterceptor },
  ],
  exports: [PlatformAuditService],
})
export class PlatformAuditModule {}
