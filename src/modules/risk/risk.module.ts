import { Global, Module } from '@nestjs/common';
import { RiskService } from './risk.service';

/**
 * Global because both account creation and checkout consult it, and neither
 * should reach across into the other's module to do so.
 */
@Global()
@Module({
  providers: [RiskService],
  exports: [RiskService],
})
export class RiskModule {}
