import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MailModule } from '../mail/mail.module';
import { StaffController } from './staff.controller';
import { StaffService } from './staff.service';

/**
 * Shop-console access management: team roster, role changes and the email
 * invite flow (24h single-use links). See common/auth/admin-permissions.ts
 * for what each assignable role can do.
 */
@Module({
  imports: [AuthModule, MailModule],
  controllers: [StaffController],
  providers: [StaffService],
})
export class StaffModule {}
