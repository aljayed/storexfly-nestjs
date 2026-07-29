import { Module } from '@nestjs/common';
import { ChatModule } from '../chat/chat.module';
import { OrdersModule } from '../orders/orders.module';
import { ChatOffersController } from './chat-offers.controller';
import { ChatOffersService } from './chat-offers.service';

/**
 * Order offers sent in chat, and the seller-initiated thread lookup.
 *
 * Deliberately its own module: ChatModule is self-contained and imports no
 * feature module, so anything needing both chat and orders has to sit above
 * them. That keeps the chat module liftable into another host, which is the
 * property its README asks callers to preserve.
 */
@Module({
  imports: [ChatModule, OrdersModule],
  controllers: [ChatOffersController],
  providers: [ChatOffersService],
})
export class ChatOffersModule {}
