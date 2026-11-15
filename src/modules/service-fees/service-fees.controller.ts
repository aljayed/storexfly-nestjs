import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { dollarsToCents } from '../../common/utils/money.util';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { RequirePerm } from '../../common/decorators/roles.decorator';
import { AdminJwtAuthGuard } from '../../common/guards/admin-jwt-auth.guard';
import { PlatformJwtAuthGuard } from '../../common/guards/platform-jwt-auth.guard';
import { PlatformArea } from '../../common/decorators/platform-area.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ShopScopeGuard } from '../../common/guards/shop-scope.guard';
import type { PlatformPrincipal } from '../../common/types/principal';
import {
  PayServiceFeeDto,
  PayServiceFeeResponse,
  PlatformServiceFeesResponse,
  RecordServiceFeePaymentDto,
  ServiceFeeStatementResponse,
  ServiceFeeSummaryResponse,
} from './service-fees.dto';
import { ServiceFeesService } from './service-fees.service';

/** Seller console: the shop's service-fee balance, and paying it. */
@ApiTags('service-fees')
@Controller('shops/:shopId/service-fees')
@Public()
@UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
@ApiBearerAuth()
export class ServiceFeesController {
  constructor(private readonly fees: ServiceFeesService) {}

  /**
   * Open to everyone on the shop's team, not only those who may see
   * settlements: whoever is at the console when a deadline is running
   * should see that it is, even if paying is somebody else's job.
   */
  @Get('summary')
  @ApiOperation({ summary: 'Admin: where the shop stands on its service fee' })
  @ApiOkResponse({ type: ServiceFeeSummaryResponse })
  summary(@Param('shopId') shopId: string) {
    return this.fees.summaryFor(shopId);
  }

  @Get()
  @RequirePerm('settlements.view')
  @ApiOperation({ summary: 'Admin: service-fee statement, order by order' })
  @ApiOkResponse({ type: ServiceFeeStatementResponse })
  statement(@Param('shopId') shopId: string) {
    return this.fees.statementFor(shopId);
  }

  @Post('pay')
  @RequirePerm('settlements.view')
  @ApiOperation({ summary: 'Admin: open a gateway session for the balance' })
  @ApiOkResponse({ type: PayServiceFeeResponse })
  pay(@Param('shopId') shopId: string, @Body() dto: PayServiceFeeDto) {
    return this.fees.pay(shopId, dto.gateway);
  }
}

/** Operator console: who owes what, and recording money received by hand. */
@ApiTags('platform-admin')
@Public()
@UseGuards(PlatformJwtAuthGuard)
@PlatformArea('finance')
@ApiBearerAuth()
@Controller('platform/service-fees')
export class PlatformServiceFeesController {
  constructor(private readonly fees: ServiceFeesService) {}

  @Get()
  @ApiOperation({ summary: 'Platform admin: service-fee balances by shop' })
  @ApiOkResponse({ type: PlatformServiceFeesResponse })
  list() {
    return this.fees.forPlatform();
  }

  @Get(':shopId')
  @ApiOperation({ summary: "Platform admin: one shop's statement" })
  @ApiOkResponse({ type: ServiceFeeStatementResponse })
  statement(@Param('shopId', ParseUUIDPipe) shopId: string) {
    return this.fees.statementForPlatform(shopId);
  }

  @Post(':shopId/payments')
  @ApiOperation({
    summary: 'Platform admin: record a payment received outside the gateway',
  })
  @ApiOkResponse({ type: ServiceFeeStatementResponse })
  record(
    @CurrentUser() actor: PlatformPrincipal,
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Body() dto: RecordServiceFeePaymentDto,
  ) {
    return this.fees.recordManualPayment(shopId, {
      amountCents: dollarsToCents(dto.amount),
      note: dto.note,
      recordedBy: actor.email,
    });
  }
}
