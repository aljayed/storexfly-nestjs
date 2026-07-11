import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ChatGateway } from './chat.gateway';
import { ChatAuthGuard } from './chat-auth.guard';
import { ChatRealtimeService } from './chat-realtime.service';
import { ChatTokenService } from './chat-token.service';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';
import { MessagesService } from './messages.service';
import { QuickRepliesController } from './quick-replies.controller';
import { QuickRepliesService } from './quick-replies.service';

/**
 * Hoomri Chat — standalone customer ↔ seller messaging
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
    MessagesService,
    QuickRepliesService,
    ChatGateway,
  ],
})
export class ChatModule {}
