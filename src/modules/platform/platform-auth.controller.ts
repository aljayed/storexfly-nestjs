import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { PlatformJwtAuthGuard } from '../../common/guards/platform-jwt-auth.guard';
import type { PlatformPrincipal } from '../../common/types/principal';
import { PlatformLoginDto } from './dto/platform-login.dto';
import { PlatformAuthService } from './platform-auth.service';

@ApiTags('platform-admin')
@Controller('platform/auth')
export class PlatformAuthController {
  constructor(private readonly auth: PlatformAuthService) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  @ApiOperation({
    summary: 'Platform admin: sign in with the operator credentials',
  })
  login(@Body() dto: PlatformLoginDto) {
    return this.auth.login(dto);
  }

  @Public()
  @UseGuards(PlatformJwtAuthGuard)
  @ApiBearerAuth()
  @Get('me')
  @ApiOperation({ summary: 'Platform admin: current session' })
  @ApiOkResponse({ description: 'The authenticated platform operator' })
  me(@CurrentUser() user: PlatformPrincipal) {
    return { email: user.email, name: 'Platform Admin' };
  }
}
