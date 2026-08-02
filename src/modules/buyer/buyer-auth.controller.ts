import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import type { AccountPrincipal } from '../../common/types/principal';
import { EmailOtpVerifyDto } from '../auth/dto/email-otp-verify.dto';
import { BuyerService } from './buyer.service';
import {
  BuyerAuthResponse,
  BuyerLoginDto,
  BuyerRegisterDto,
} from './dto/buyer-auth.dto';

/** Buyer (shopper) accounts - register / login / current session. */
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
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('signup')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Buyer: start account creation, sends a verification code' })
  signupStart(@Body() dto: BuyerRegisterDto) {
    return this.buyers.signupStart(dto);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('signup/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Buyer: verify the code and complete account creation' })
  @ApiOkResponse({ type: BuyerAuthResponse })
  signupVerify(@Body() dto: EmailOtpVerifyDto) {
    return this.buyers.signupVerify(dto.email, dto.code);
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
