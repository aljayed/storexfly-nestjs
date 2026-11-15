import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PlatformAnyStaff } from '../../common/decorators/platform-area.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { PlatformJwtAuthGuard } from '../../common/guards/platform-jwt-auth.guard';
import type { PlatformPrincipal } from '../../common/types/principal';
import { PlatformCommandService } from './platform-command.service';

/** Command center and global search: open to every role, filtered inside. */
@ApiTags('platform-admin')
@Public()
@UseGuards(PlatformJwtAuthGuard)
@PlatformAnyStaff()
@ApiBearerAuth()
@Controller('platform')
export class PlatformCommandController {
  constructor(private readonly command: PlatformCommandService) {}

  @Get('command-center')
  @ApiOperation({
    summary: "Platform console: today's queues, pulse and changes",
  })
  overview(@CurrentUser() user: PlatformPrincipal) {
    return this.command.overview(user);
  }

  @Get('search')
  @ApiOperation({ summary: 'Platform console: find shops, buyers and orders' })
  search(@CurrentUser() user: PlatformPrincipal, @Query('q') q = '') {
    return this.command.search(user, String(q));
  }
}
