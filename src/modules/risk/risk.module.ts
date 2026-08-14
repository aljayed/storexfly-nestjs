import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthModule } from '../auth/auth.module';
import { MailModule } from '../mail/mail.module';
import { UsersModule } from '../users/users.module';
import { EmailProofService } from './email-proof.service';
import { PhoneProofService } from './phone-proof.service';
import { RiskService } from './risk.service';

/**
 * Global because account creation and checkout both consult it, and neither
 * should reach into the other's module to do so.
 */
@Global()
@Module({
  imports: [JwtModule.register({}), AuthModule, MailModule, UsersModule],
  providers: [RiskService, PhoneProofService, EmailProofService],
  exports: [RiskService, PhoneProofService, EmailProofService],
})
export class RiskModule {}
