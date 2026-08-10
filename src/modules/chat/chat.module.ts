import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ChatGateway } from './chat.gateway';
import { BotReplyService } from './bot-reply.service';
import { ChatAuthGuard } from './chat-auth.guard';
import { ChatRealtimeService } from './chat-realtime.service';
import { ChatTokenService } from './chat-token.service';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';
import { HandleLookupService } from './handle-lookup.service';
import { MessagesService } from './messages.service';
import { QuickRepliesController } from './quick-replies.controller';
import { QuickRepliesService } from './quick-replies.service';

/**
 * Hoomri Chat - standalone customer ↔ seller messaging
 * (design_handoff_hoomri_chat). Self-contained on purpose: it depends only on
 * the global DatabaseModule and the platform's JWT secrets (via
 * ChatTokenService, its single auth seam), never on the other feature
 * modules, so it can be lifted into another NestJS host with minimal edits.
 */
@Module({
  imports: [JwtModule.register({})],
  controllers: [ConversationsController, QuickRepliesController],
  providers: [
    ChatTokenService,
    ChatAuthGuard,
    ChatRealtimeService,
    ConversationsService,
    HandleLookupService,
    BotReplyService,
    MessagesService,
    QuickRepliesService,
    ChatGateway,
  ],
  // Exported so the platform can post shop-initiated cards (e.g. order-amount
  // changes) into a thread. Chat still imports no feature module - the
  // dependency is one-way (orders → chat).
  //
  // The guard and its token service go out too, so a module layered on top
  // (chat-offers) can protect its own routes with the same auth seam instead
  // of re-implementing one. Still no inward dependency.
  exports: [MessagesService, ChatAuthGuard, ChatTokenService],
})
export class ChatModule {}
