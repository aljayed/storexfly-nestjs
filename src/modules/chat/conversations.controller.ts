import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
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
  StartWithHandleDto,
} from './dto/chat.dto';
import { HandleLookupService } from './handle-lookup.service';
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
    private readonly handles: HandleLookupService,
  ) {}

  /**
   * Look up "@name" so a chat can be started with whoever holds it.
   *
   * Handles are the only public way to find a person here: an address lookup
   * would let anyone confirm which emails have accounts. A miss reads the same
   * as an unclaimed name, so this cannot be walked as a directory either.
   */
  @Get('handle/:handle')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Resolve a public handle to someone messageable' })
  async lookupHandle(@Param('handle') handle: string) {
    const target = await this.handles.resolve(handle);
    if (!target) throw new NotFoundException('No one uses that name');
    return target;
  }

  /**
   * Open (or return) a thread with whoever holds a handle - a storefront, or a
   * person. Hoomri Support uses the same route, which is what makes a support
   * thread ordinary rather than a special case.
   */
  @Post('with')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Start (or return) a thread with a handle' })
  async startWith(
    @CurrentChatActor() actor: ChatActor,
    @Body() dto: StartWithHandleDto,
  ) {
    const target = await this.handles.resolve(dto.handle);
    if (!target) throw new NotFoundException('No one uses that name');
    const { conversation, created } = await this.conversations.startWithParty(
      actor,
      target.kind === 'shop'
        ? { kind: 'shop', id: target.shopId }
        : { kind: 'account', id: target.accountId },
    );
    return { conversation, created };
  }

  /**
   * Hoomri Support opening a thread with a shop, from the platform console.
   * By shop id rather than handle, because that is what the console has.
   */
  @ChatRole('support')
  @Post('support/shop/:shopId')
  @ApiOperation({ summary: 'Support: start (or return) a thread with a shop' })
  startSupportThread(
    @CurrentChatActor() actor: ChatActor,
    @Param('shopId', ParseUUIDPipe) shopId: string,
  ) {
    return this.conversations.startWithParty(actor, { kind: 'shop', id: shopId });
  }

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
      'Start (or return) the thread with a shop - used by "Chat with seller"',
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
