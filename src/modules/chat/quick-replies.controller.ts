import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import type { SellerActor } from './chat-actor';
import { ChatAuthGuard, ChatRole, CurrentChatActor } from './chat-auth.guard';
import { QuickReplyDto, ReorderQuickRepliesDto } from './dto/chat.dto';
import { QuickRepliesService } from './quick-replies.service';

/** Seller canned responses. Shop scope comes from the admin token. */
@ApiTags('chat')
@Public()
@UseGuards(ChatAuthGuard)
@ChatRole('seller')
@ApiBearerAuth()
@Controller('chat/quick-replies')
export class QuickRepliesController {
  constructor(private readonly quickReplies: QuickRepliesService) {}

  @Get()
  @ApiOperation({ summary: "Seller: the shop's quick replies" })
  list(@CurrentChatActor() actor: SellerActor) {
    return this.quickReplies.list(actor);
  }

  @Post()
  @ApiOperation({ summary: 'Seller: add a quick reply' })
  create(@CurrentChatActor() actor: SellerActor, @Body() dto: QuickReplyDto) {
    return this.quickReplies.create(actor, dto);
  }

  // Declared before ':id' so Nest doesn't route "order" into the UUID param.
  @Patch('order')
  @ApiOperation({ summary: 'Seller: reorder the quick replies' })
  reorder(
    @CurrentChatActor() actor: SellerActor,
    @Body() dto: ReorderQuickRepliesDto,
  ) {
    return this.quickReplies.reorder(actor, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Seller: edit a quick reply' })
  update(
    @CurrentChatActor() actor: SellerActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: QuickReplyDto,
  ) {
    return this.quickReplies.update(actor, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Seller: delete a quick reply' })
  async remove(
    @CurrentChatActor() actor: SellerActor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.quickReplies.remove(actor, id);
  }
}
