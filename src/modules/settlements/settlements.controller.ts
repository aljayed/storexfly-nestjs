import { Controller, Get, Param, UseGuards } from '@nestjs/common';
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
import { ShopSettlementsResponse } from './dto/settlement.response';
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
}
