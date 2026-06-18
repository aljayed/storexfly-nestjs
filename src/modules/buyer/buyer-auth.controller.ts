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
import { BuyerJwtAuthGuard } from '../../common/guards/buyer-jwt-auth.guard';
import type { BuyerPrincipal } from '../../common/types/principal';
import { BuyerService } from './buyer.service';
import {
  BuyerAuthResponse,
  BuyerLoginDto,
  BuyerRegisterDto,
} from './dto/buyer-auth.dto';

/** Buyer (shopper) accounts — register / login / current session. */
@ApiTags('buyer')
@Controller('buyer/auth')
export class BuyerAuthController {
  constructor(private readonly buyers: BuyerService) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('register')
  @ApiOperation({ summary: 'Buyer: create an account' })
  @ApiOkResponse({ type: BuyerAuthResponse })
  register(@Body() dto: BuyerRegisterDto) {
    return this.buyers.register(dto);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  @ApiOperation({ summary: 'Buyer: sign in' })
  @ApiOkResponse({ type: BuyerAuthResponse })
  login(@Body() dto: BuyerLoginDto) {
    return this.buyers.login(dto);
  }

  @Public()
  @UseGuards(BuyerJwtAuthGuard)
  @ApiBearerAuth()
  @Get('me')
  @ApiOperation({ summary: 'Buyer: current session' })
  async me(@CurrentUser() user: BuyerPrincipal) {
    const row = await this.buyers.findById(user.id);
    return row ? this.buyers.me(row) : null;
  }
}
