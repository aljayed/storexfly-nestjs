import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthModule } from '../auth/auth.module';
import { PhoneProofService } from './phone-proof.service';
import { RiskService } from './risk.service';

/**
 * Global because account creation and checkout both consult it, and neither
 * should reach into the other's module to do so.
 */
@Global()
@Module({
  imports: [JwtModule.register({}), AuthModule],
  providers: [RiskService, PhoneProofService],
  exports: [RiskService, PhoneProofService],
})
export class RiskModule {}
