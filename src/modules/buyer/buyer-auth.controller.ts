import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { StorefrontSession } from '../../common/decorators/storefront-session.decorator';
import { Public } from '../../common/decorators/public.decorator';
import type { AccountPrincipal } from '../../common/types/principal';
import { BuyerService } from './buyer.service';
import {
  BuyerAuthResponse,
  BuyerLoginDto,
  BuyerRegisterDto,
} from './dto/buyer-auth.dto';

/** Buyer (shopper) accounts - register / login / current session. */
@StorefrontSession()
@ApiTags('buyer')
@Controller('buyer/auth')
export class BuyerAuthController {
  constructor(private readonly buyers: BuyerService) {}

  /**
   * Shopper sign-up: instant, no verification code. Used both by the "create
   * my account" tick at checkout and by the storefront sign-up modal - making
   * a shopper break off to fetch a code from their inbox is the surest way to
   * lose them. The account is created unverified and the session it gets is
   * `storefront`-scoped, which is what keeps the low friction safe.
   */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('register')
  @ApiOperation({ summary: 'Buyer: create an account (no verification code)' })
  @ApiOkResponse({ type: BuyerAuthResponse })
  register(@Body() dto: BuyerRegisterDto, @Req() req: Request) {
    return this.buyers.register(dto, req.ip);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  @ApiOperation({ summary: 'Buyer: sign in' })
  @ApiOkResponse({ type: BuyerAuthResponse })
  login(@Body() dto: BuyerLoginDto) {
    return this.buyers.login(dto);
  }

  @ApiBearerAuth()
  @Get('me')
  @ApiOperation({ summary: 'Account: current storefront session' })
  async me(@CurrentUser() user: AccountPrincipal) {
    const row = await this.buyers.findById(user.id);
    return row ? this.buyers.me(row) : null;
  }
}
