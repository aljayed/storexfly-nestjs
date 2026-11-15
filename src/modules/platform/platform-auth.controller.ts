import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PlatformAnyStaff } from '../../common/decorators/platform-area.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { PlatformJwtAuthGuard } from '../../common/guards/platform-jwt-auth.guard';
import type { PlatformPrincipal } from '../../common/types/principal';
import {
  PlatformChangePasswordDto,
  PlatformCodeDto,
  PlatformLoginDto,
  PlatformNewPasswordDto,
} from './dto/platform-login.dto';
import { PlatformAuthService } from './platform-auth.service';

@ApiTags('platform-admin')
@Controller('platform/auth')
export class PlatformAuthController {
  constructor(private readonly auth: PlatformAuthService) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  @ApiOperation({ summary: 'Platform console: step 1, email and password' })
  login(@Body() dto: PlatformLoginDto, @Req() req: Request) {
    return this.auth.login(dto, req);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('code')
  @ApiOperation({ summary: 'Platform console: step 2, authenticator code' })
  code(@Body() dto: PlatformCodeDto, @Req() req: Request) {
    return this.auth.verifyCode(dto, req);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('first-password')
  @ApiOperation({ summary: 'Platform console: replace an assigned password' })
  firstPassword(@Body() dto: PlatformNewPasswordDto, @Req() req: Request) {
    return this.auth.setFirstPassword(dto, req);
  }

  @Public()
  @UseGuards(PlatformJwtAuthGuard)
  @PlatformAnyStaff()
  @ApiBearerAuth()
  @Get('me')
  @ApiOperation({
    summary: 'Platform console: who is signed in, and their access',
  })
  me(@CurrentUser() user: PlatformPrincipal) {
    return this.auth.profile(user.id);
  }

  @Public()
  @UseGuards(PlatformJwtAuthGuard)
  @PlatformAnyStaff()
  @ApiBearerAuth()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('password')
  @ApiOperation({ summary: 'Platform console: change my password' })
  changePassword(
    @CurrentUser() user: PlatformPrincipal,
    @Body() dto: PlatformChangePasswordDto,
  ) {
    return this.auth.changePassword(user, dto);
  }

  @Public()
  @UseGuards(PlatformJwtAuthGuard)
  @PlatformAnyStaff()
  @ApiBearerAuth()
  @Post('sign-out-everywhere')
  @ApiOperation({ summary: 'Platform console: end all my sessions' })
  signOutEverywhere(@CurrentUser() user: PlatformPrincipal) {
    return this.auth.signOutEverywhere(user.id);
  }
}
