import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
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
import {
  PERIOD_PATTERN,
  PlatformSettlementsQueryDto,
  SettlementDecisionDto,
} from './dto/settlement-query.dto';
import {
  DeletedShopSettlementResponse,
  PlatformSettlementRowResponse,
  PlatformSettlementsResponse,
} from './dto/platform-settlement.response';
import { SettlementsService } from './settlements.service';

/** Operator console: review shop payouts per month and record payments. */
@ApiTags('platform-admin')
@Public()
@UseGuards(PlatformJwtAuthGuard)
@ApiBearerAuth()
@Controller('platform')
export class PlatformSettlementsController {
  constructor(private readonly settlements: SettlementsService) {}

  @Get('settlements')
  @ApiOperation({ summary: 'Platform admin: shop-wise payouts for a month' })
  @ApiOkResponse({ type: PlatformSettlementsResponse })
  list(@Query() query: PlatformSettlementsQueryDto) {
    return this.settlements.forPlatform(query.period);
  }

  // Declared before ':shopId/:period' so "deleted" never parses as a shop id.
  @Get('settlements/deleted')
  @ApiOperation({
    summary: 'Platform admin: payouts still owed to deleted shops',
  })
  @ApiOkResponse({ type: [DeletedShopSettlementResponse] })
  listDeleted() {
    return this.settlements.listDeleted();
  }

  @Patch('settlements/deleted/:id')
  @ApiOperation({
    summary: 'Platform admin: mark a deleted-shop payout (un)paid',
  })
  @ApiOkResponse({ type: DeletedShopSettlementResponse })
  decideDeleted(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SettlementDecisionDto,
  ) {
    return this.settlements.decideDeleted(id, dto.paid, dto.note);
  }

  @Patch('settlements/:shopId/:period')
  @ApiOperation({
    summary: 'Platform admin: mark a shop-month payout (un)paid',
  })
  @ApiOkResponse({ type: PlatformSettlementRowResponse })
  decide(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('period') period: string,
    @Body() dto: SettlementDecisionDto,
  ) {
    if (!PERIOD_PATTERN.test(period)) {
      throw new BadRequestException('period must be "YYYY-MM"');
    }
    return this.settlements.decide(shopId, period, dto.paid, dto.note);
  }
}
