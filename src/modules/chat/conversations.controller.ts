import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import type { ChatActor, CustomerActor, SellerActor } from './chat-actor';
import { ChatAuthGuard, ChatRole, CurrentChatActor } from './chat-auth.guard';
import { ConversationsService } from './conversations.service';
import {
  ListConversationsQuery,
  ListMessagesQuery,
  MarkReadDto,
  SendMessageDto,
  StartConversationDto,
} from './dto/chat.dto';
import { MessagesService } from './messages.service';

/**
 * Chat REST surface. `@Public()` opts these routes out of the global
 * seller-JWT guard; ChatAuthGuard then accepts either a buyer session
 * (customer side) or an admin-console session (seller side).
 */
@ApiTags('chat')
@Public()
@UseGuards(ChatAuthGuard)
@ApiBearerAuth()
@Controller('chat/conversations')
export class ConversationsController {
  constructor(
    private readonly conversations: ConversationsService,
    private readonly messages: MessagesService,
  ) {}

  @Get()
  @ApiOperation({ summary: "List the caller's conversations" })
  list(
    @CurrentChatActor() actor: ChatActor,
    @Query() query: ListConversationsQuery,
  ) {
    return this.conversations.list(actor, query);
  }

  @Post()
  @ChatRole('customer')
  @ApiOperation({
    summary:
      'Start (or return) the thread with a shop — used by "Chat with seller"',
  })
  async start(
    @CurrentChatActor() actor: CustomerActor,
    @Body() dto: StartConversationDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { conversation, created } = await this.conversations.start(
      actor,
      dto,
    );
    // Attach the product/order card only when the thread is new or was
    // re-entered from a different item, so repeat clicks don't spam cards.
    if (created && dto.initialMessage) {
      await this.messages.send(actor, conversation.id, dto.initialMessage);
    }
    res.status(created ? 201 : 200);
    return this.conversations.getById(actor, conversation.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One conversation (participants only)' })
  get(
    @CurrentChatActor() actor: ChatActor,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.conversations.getById(actor, id);
  }

  @Get(':id/context')
  @ChatRole('seller')
  @ApiOperation({ summary: 'Seller: customer context panel' })
  context(
    @CurrentChatActor() actor: SellerActor,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.conversations.context(actor, id);
  }

  @Get(':id/products')
  @ApiOperation({ summary: "The shop's catalogue, for the product picker" })
  catalogue(
    @CurrentChatActor() actor: ChatActor,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.conversations.catalogue(actor, id);
  }

  @Get(':id/messages')
  @ApiOperation({ summary: 'Thread history (paginates backwards)' })
  listMessages(
    @CurrentChatActor() actor: ChatActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListMessagesQuery,
  ) {
    return this.messages.list(actor, id, query);
  }

  @Post(':id/messages')
  @ApiOperation({ summary: 'Send a message' })
  send(
    @CurrentChatActor() actor: ChatActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendMessageDto,
  ) {
    return this.messages.send(actor, id, dto);
  }

  @Post(':id/read')
  @HttpCode(204)
  @ApiOperation({ summary: 'Mark the thread read up to a message' })
  async read(
    @CurrentChatActor() actor: ChatActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MarkReadDto,
  ): Promise<void> {
    await this.messages.markRead(actor, id, dto);
  }
}
