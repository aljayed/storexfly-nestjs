import { Module } from '@nestjs/common';
import { MailAccountsService } from './mail-accounts.service';
import { MailService } from './mail.service';

/**
 * Outbound mail, plus management of the staff mailboxes on the platform's own
 * domain. Two different jobs against the same mail domain: MailService sends
 * through it, MailAccountsService decides who has a mailbox on it.
 */
@Module({
  providers: [MailService, MailAccountsService],
  exports: [MailService, MailAccountsService],
})
export class MailModule {}
