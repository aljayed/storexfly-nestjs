import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { AdminJwtAuthGuard } from '../../common/guards/admin-jwt-auth.guard';
import { ShopScopeGuard } from '../../common/guards/shop-scope.guard';
import { NoticeListResponse } from './dto/notice.dto';
import { NoticesService } from './notices.service';

/** Seller console: the active platform announcements for this shop. */
@ApiTags('notices')
@Controller('shops/:shopId')
@Public()
@UseGuards(AdminJwtAuthGuard, ShopScopeGuard)
@ApiBearerAuth()
export class NoticesController {
  constructor(private readonly notices: NoticesService) {}

  @Get('notices')
  @ApiOperation({ summary: 'Admin: active platform notices for the shop' })
  @ApiOkResponse({ type: NoticeListResponse })
  list(@Param('shopId') shopId: string) {
    return this.notices.listForShop(shopId);
  }
}
