import { Module } from '@nestjs/common';
import { EmailOtpService } from '../auth/email-otp.service';
import { BlockedWordsModule } from '../blocked-words/blocked-words.module';
import { GatewaysModule } from '../gateways/gateways.module';
import { MailModule } from '../mail/mail.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { ShopCourierController } from './shop-courier.controller';
import { ShopsController } from './shops.controller';
import { ShopsService } from './shops.service';

@Module({
  // EmailOtpService is provided here (not pulled from AuthModule, which
  // already imports ShopsModule - a cycle). The instance is separate from
  // auth's, which is fine: the delete-shop codes are both issued and
  // verified through ShopsService, so they live in this instance's store.
  imports: [
    SubscriptionsModule,
    BlockedWordsModule,
    GatewaysModule,
    MailModule,
  ],
  controllers: [ShopsController, ShopCourierController],
  providers: [ShopsService, EmailOtpService],
  exports: [ShopsService],
})
export class ShopsModule {}
