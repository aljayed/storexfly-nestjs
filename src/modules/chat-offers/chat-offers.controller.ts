import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import type { ChatActor, CustomerActor, SellerActor } from '../chat/chat-actor';
import {
  ChatAuthGuard,
  ChatRole,
  CurrentChatActor,
} from '../chat/chat-auth.guard';
import { ChatOffersService } from './chat-offers.service';
import {
  CreateOfferDto,
  RespondOfferDto,
  StartWithCustomerDto,
} from './dto/offer.dto';

/**
 * Order offers in chat. Same auth seam as the rest of chat: `@Public()` opts
 * out of the global seller-JWT guard and ChatAuthGuard admits either a buyer
 * session or an admin-console session, with `@ChatRole` narrowing per route.
 */
@ApiTags('chat-offers')
@Public()
@UseGuards(ChatAuthGuard)
@ApiBearerAuth()
@Controller('chat')
export class ChatOffersController {
  constructor(private readonly offers: ChatOffersService) {}

  @ChatRole('seller')
  @Post('customers/lookup')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Seller: open a thread with a customer by phone or email',
  })
  startWithCustomer(
    @CurrentChatActor() actor: SellerActor,
    @Body() dto: StartWithCustomerDto,
  ) {
    return this.offers.startWithCustomer(actor, dto);
  }

  @ChatRole('seller')
  @Post('conversations/:id/offers')
  @ApiOperation({ summary: 'Seller: send an order offer into the thread' })
  create(
    @CurrentChatActor() actor: SellerActor,
    @Param('id', ParseUUIDPipe) conversationId: string,
    @Body() dto: CreateOfferDto,
  ) {
    return this.offers.create(actor, conversationId, dto);
  }

  // Support has no seat in an offer: it is a shop selling to a buyer.
  @ChatRole('customer', 'seller')
  @Get('offers/:id')
  @ApiOperation({ summary: 'Read one offer (either side of the thread)' })
  getById(
    @CurrentChatActor() actor: CustomerActor | SellerActor,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.offers.getById(actor, id);
  }

  @ChatRole('customer')
  @Post('offers/:id/respond')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Buyer: accept (places the order) or reject an offer',
  })
  respond(
    @CurrentChatActor() actor: CustomerActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RespondOfferDto,
  ) {
    return this.offers.respond(actor, id, dto);
  }

  @ChatRole('seller')
  @Post('offers/:id/withdraw')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Seller: withdraw an unanswered offer' })
  withdraw(
    @CurrentChatActor() actor: SellerActor,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.offers.withdraw(actor, id);
  }
}
