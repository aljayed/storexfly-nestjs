import {
  BadRequestException,
  Controller,
  Get,
  Param,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { RequirePerm } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AdminJwtAuthGuard } from '../../common/guards/admin-jwt-auth.guard';
import { ShopScopeGuard } from '../../common/guards/shop-scope.guard';
import {
  SettlementProofResponse,
  ShopSettlementsResponse,
} from './dto/settlement.response';
import { PERIOD_PATTERN } from './dto/settlement-query.dto';
import { SettlementsService } from './settlements.service';

/** Seller-facing view of their monthly payouts. */
@ApiTags('settlements')
@Controller('shops/:shopId')
@Public()
@UseGuards(AdminJwtAuthGuard, ShopScopeGuard, RolesGuard)
@RequirePerm('settlements.view')
@ApiBearerAuth()
export class SettlementsController {
  constructor(private readonly settlements: SettlementsService) {}

  @Get('settlements')
  @ApiOperation({ summary: 'Admin: month-wise payout breakdown for the shop' })
  @ApiOkResponse({ type: ShopSettlementsResponse })
  list(@Param('shopId') shopId: string) {
    return this.settlements.forShop(shopId);
  }

  /**
   * The receipt for one of this shop's payouts. Scoped to the shop by the
   * guard above, so a seller can only ever fetch proof of their own money.
   * The document comes back as a data URL rather than a file: it is held
   * inline, and a console that already holds the row can render it without
   * putting a payment document on a public URL.
   */
  @Get('settlements/:period/receipts/:index')
  @ApiOperation({ summary: 'Admin: proof of one transfer to this shop' })
  @ApiOkResponse({ type: SettlementProofResponse })
  receipt(
    @Param('shopId') shopId: string,
    @Param('period') period: string,
    @Param('index') index: string,
  ) {
    if (!PERIOD_PATTERN.test(period)) {
      throw new BadRequestException('period must be "YYYY-MM"');
    }
    return this.settlements.proofFor(shopId, period, asIndex(index));
  }
}

/** A receipt is addressed by its place in the cycle's list, nothing fancier. */
function asIndex(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new BadRequestException('receipt index must be a whole number');
  }
  return n;
}
