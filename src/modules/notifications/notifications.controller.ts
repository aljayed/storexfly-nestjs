import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { BuyerJwtAuthGuard } from '../../common/guards/buyer-jwt-auth.guard';
import type { BuyerPrincipal } from '../../common/types/principal';
import { NotificationsService } from './notifications.service';

/** Buyer in-app notifications (order updates), shown on the profile screen. */
@ApiTags('buyer')
// @Public() opts out of the global *seller* JWT guard; the buyer guard below is
// what actually authenticates these routes (same pattern as the buyer profile).
@Public()
@UseGuards(BuyerJwtAuthGuard)
@ApiBearerAuth()
@Controller('buyer/notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'Buyer: notifications + unread count' })
  list(@CurrentUser() user: BuyerPrincipal) {
    return this.notifications.listForBuyer(user.id);
  }

  @Post('read-all')
  @ApiOperation({ summary: 'Buyer: mark every notification read' })
  markAllRead(@CurrentUser() user: BuyerPrincipal) {
    return this.notifications.markAllRead(user.id);
  }
}
