import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { PlatformJwtAuthGuard } from '../../common/guards/platform-jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { StorefrontSession } from '../../common/decorators/storefront-session.decorator';
import { RequirePerm } from '../../common/decorators/roles.decorator';
import { AdminJwtAuthGuard } from '../../common/guards/admin-jwt-auth.guard';
import { ShopScopeGuard } from '../../common/guards/shop-scope.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import type { AccountPrincipal } from '../../common/types/principal';
import { CommerceService } from './commerce.service';
import {
  DisputeDecisionDto,
  OpenDisputeDto,
  QuoteDecisionDto,
  RequestQuoteDto,
  ResolveDisputeDto,
  RespondQuoteDto,
  RepriceListingsDto,
  ResellerListingDto,
  TradeMessageDto,
  UpdateResellerListingDto,
} from './commerce.dto';
@Controller('commerce')
export class CommercePublicController {
  constructor(private readonly service: CommerceService) {}
  @Public() @Get('stores/:handle') store(@Param('handle') handle: string) {
    return this.service.publicStore(handle);
  }
  @Public() @Get('listings/:id') listing(
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.publicListing(id);
  }
}
@StorefrontSession()
@Controller('buyer/trade')
export class CommerceBuyerController {
  constructor(private readonly service: CommerceService) {}
  @Get('orders') orders(@CurrentUser() user: AccountPrincipal) {
    return this.service.buyerOrders(user.id);
  }
  @Get('quotes') quotes(@CurrentUser() user: AccountPrincipal) {
    return this.service.quotes({ buyerId: user.id });
  }
  @Post('quotes') request(
    @CurrentUser() user: AccountPrincipal,
    @Body() dto: RequestQuoteDto,
  ) {
    return this.service.requestQuote(user.id, dto);
  }
  @Patch('quotes/:id') decide(
    @CurrentUser() user: AccountPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: QuoteDecisionDto,
  ) {
    return this.service.decideQuote(user.id, id, dto.action);
  }
  @Post('quotes/:id/messages') message(
    @CurrentUser() user: AccountPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TradeMessageDto,
  ) {
    return this.service.messageQuote({ buyerId: user.id }, id, dto.text);
  }
  @Get('disputes') disputes(@CurrentUser() user: AccountPrincipal) {
    return this.service.disputes({ buyerId: user.id });
  }
  @Patch('disputes/:id') decideDispute(
    @CurrentUser() user: AccountPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DisputeDecisionDto,
  ) {
    return this.service.decideDispute(user.id, id, dto.action);
  }
  @Post('disputes') dispute(
    @CurrentUser() user: AccountPrincipal,
    @Body() dto: OpenDisputeDto,
  ) {
    return this.service.openDispute(user.id, dto);
  }
}
@Public()
@UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
@Controller('shops/:shopId/trade')
export class CommerceAdminController {
  constructor(private readonly service: CommerceService) {}
  @RequirePerm('items.view') @Get('listings') listings(
    @Param('shopId', ParseUUIDPipe) shopId: string,
  ) {
    return this.service.listings(shopId);
  }
  @RequirePerm('items.add') @Get('source/:id') source(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.sourceOffer(shopId, id);
  }
  @RequirePerm('items.add') @Post('listings') import(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Body() dto: ResellerListingDto,
  ) {
    return this.service.importListing(shopId, dto);
  }
  // Declared before `listings/:id` so the literal path is never read as an id.
  @RequirePerm('items.edit') @Post('listings/reprice') reprice(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Body() dto: RepriceListingsDto,
  ) {
    return this.service.repriceListings(shopId, dto.items);
  }
  @RequirePerm('items.edit') @Patch('listings/:id') update(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateResellerListingDto,
  ) {
    return this.service.updateListing(shopId, id, dto);
  }
  @RequirePerm('reports.view') @Get('summary') summary(
    @Param('shopId', ParseUUIDPipe) shopId: string,
  ) {
    return this.service.summary(shopId);
  }
  @RequirePerm('orders.manage') @Get('orders') orders(
    @Param('shopId', ParseUUIDPipe) shopId: string,
  ) {
    return this.service.resellerOrders(shopId);
  }
  @RequirePerm('orders.manage') @Get('quotes') quotes(
    @Param('shopId', ParseUUIDPipe) shopId: string,
  ) {
    return this.service.quotes({ shopId });
  }
  @RequirePerm('orders.manage') @Patch('quotes/:id') respond(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RespondQuoteDto,
  ) {
    return this.service.respondQuote(shopId, id, dto);
  }
  @RequirePerm('orders.manage') @Post('quotes/:id/messages') message(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TradeMessageDto,
  ) {
    return this.service.messageQuote({ shopId }, id, dto.text);
  }
  @RequirePerm('orders.manage') @Get('disputes') disputes(
    @Param('shopId', ParseUUIDPipe) shopId: string,
  ) {
    return this.service.disputes({ shopId });
  }
  @RequirePerm('orders.manage') @Patch('disputes/:id') resolve(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveDisputeDto,
  ) {
    return this.service.resolveDispute(shopId, id, dto.resolution);
  }
}

@Public()
@UseGuards(PlatformJwtAuthGuard)
@Controller('platform/trade')
export class CommercePlatformController {
  constructor(private readonly service: CommerceService) {}
  @Get('disputes') disputes() {
    return this.service.platformDisputes();
  }
  @Patch('disputes/:id') resolve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveDisputeDto,
  ) {
    return this.service.platformResolve(id, dto.resolution);
  }
}
