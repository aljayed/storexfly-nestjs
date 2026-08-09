import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { PlatformJwtAuthGuard } from '../../common/guards/platform-jwt-auth.guard';
import { PlatformListQueryDto } from './dto/platform-list-query.dto';
import { PlatformCustomerListResponse } from './dto/platform-customer.response';
import {
  KycDecisionDto,
  PlatformKycQueryDto,
} from './dto/platform-kyc-query.dto';
import {
  PlatformKycDetailResponse,
  PlatformKycListResponse,
} from './dto/platform-kyc.response';
import { NoticeListResponse, NoticeResponse } from '../notices/dto/notice.dto';
import {
  PlatformShopMessageDto,
  UpdatePlatformShopDto,
} from './dto/platform-shop-action.dto';
import {
  PlatformShopDetailResponse,
  PlatformShopListResponse,
} from './dto/platform-shop.response';
import { PlatformOverviewService } from './platform-overview.service';

/** Cross-shop shop/customer listings for the platform-admin console. */
@ApiTags('platform-admin')
@Public()
@UseGuards(PlatformJwtAuthGuard)
@ApiBearerAuth()
@Controller('platform')
export class PlatformOverviewController {
  constructor(private readonly overview: PlatformOverviewService) {}

  @Get('shops')
  @ApiOperation({ summary: 'Platform admin: paginated list of all shops' })
  @ApiOkResponse({ type: PlatformShopListResponse })
  listShops(@Query() query: PlatformListQueryDto) {
    return this.overview.listShops(query);
  }

  @Get('shops/:shopId')
  @ApiOperation({ summary: 'Platform admin: one shop, with lifetime trade' })
  @ApiOkResponse({ type: PlatformShopDetailResponse })
  getShop(@Param('shopId', ParseUUIDPipe) shopId: string) {
    return this.overview.getShop(shopId);
  }

  @Patch('shops/:shopId')
  @ApiOperation({
    summary: 'Platform admin: suspend / restore a shop, or switch it offline',
  })
  @ApiOkResponse({ type: PlatformShopDetailResponse })
  updateShop(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Body() dto: UpdatePlatformShopDto,
  ) {
    return this.overview.updateShop(shopId, dto);
  }

  @Get('shops/:shopId/messages')
  @ApiOperation({ summary: 'Platform admin: messages sent to one shop' })
  @ApiOkResponse({ type: NoticeListResponse })
  shopMessages(@Param('shopId', ParseUUIDPipe) shopId: string) {
    return this.overview.listShopMessages(shopId);
  }

  @Post('shops/:shopId/messages')
  @ApiOperation({ summary: "Platform admin: message one shop's seller" })
  @ApiOkResponse({ type: NoticeResponse })
  messageShop(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Body() dto: PlatformShopMessageDto,
  ) {
    return this.overview.messageShop(shopId, dto.message, dto.tone);
  }

  @Get('customers')
  @ApiOperation({ summary: 'Platform admin: paginated list of all buyers' })
  @ApiOkResponse({ type: PlatformCustomerListResponse })
  listCustomers(@Query() query: PlatformListQueryDto) {
    return this.overview.listCustomers(query);
  }

  @Get('kyc')
  @ApiOperation({ summary: 'Platform admin: shop verification (KYC) queue' })
  @ApiOkResponse({ type: PlatformKycListResponse })
  listKyc(@Query() query: PlatformKycQueryDto) {
    return this.overview.listKyc(query);
  }

  @Get('kyc/:shopId')
  @ApiOperation({ summary: 'Platform admin: one shop KYC record + document' })
  @ApiOkResponse({ type: PlatformKycDetailResponse })
  getKyc(@Param('shopId', ParseUUIDPipe) shopId: string) {
    return this.overview.getKyc(shopId);
  }

  @Patch('kyc/:shopId')
  @ApiOperation({ summary: 'Platform admin: approve or reject a shop KYC' })
  @ApiOkResponse({ type: PlatformKycDetailResponse })
  decideKyc(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Body() dto: KycDecisionDto,
  ) {
    return this.overview.decideKyc(shopId, dto.status);
  }
}
