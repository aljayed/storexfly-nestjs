import { Controller, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AccountPrincipal } from '../../common/types/principal';
import { NotificationsService } from './notifications.service';

/** In-app order notifications, shown on the account's storefront profile.
 *  Authed by the global account JWT guard. */
@ApiTags('buyer')
@ApiBearerAuth()
@Controller('buyer/notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'Account: notifications + unread count' })
  list(@CurrentUser() user: AccountPrincipal) {
    return this.notifications.listForBuyer(user.id);
  }

  @Post('read-all')
  @ApiOperation({ summary: 'Account: mark every notification read' })
  markAllRead(@CurrentUser() user: AccountPrincipal) {
    return this.notifications.markAllRead(user.id);
  }
}
