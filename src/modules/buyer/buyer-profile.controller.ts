import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { StorefrontSession } from '../../common/decorators/storefront-session.decorator';
import type { AccountPrincipal } from '../../common/types/principal';
import { BuyerService } from './buyer.service';
import { UpdateBuyerProfileDto } from './dto/buyer-overview.dto';
import { CheckHandleDto, SetHandleDto } from './dto/handle.dto';
import { VerifyCodeDto } from './dto/verify-code.dto';

/** Account storefront profile - info, order history and reviews. Authed by the
 *  global account JWT guard (the single session). */
@StorefrontSession()
@ApiTags('buyer')
@ApiBearerAuth()
@Controller('buyer/profile')
export class BuyerProfileController {
  constructor(private readonly buyers: BuyerService) {}

  @Get()
  @ApiOperation({ summary: 'Account: profile overview (account, orders, reviews)' })
  overview(@CurrentUser() user: AccountPrincipal) {
    return this.buyers.overview(user.id);
  }

  @Patch()
  @ApiOperation({ summary: 'Account: update name and saved checkout details' })
  updateProfile(
    @CurrentUser() user: AccountPrincipal,
    @Body() dto: UpdateBuyerProfileDto,
  ) {
    return this.buyers.updateProfile(user.id, dto);
  }

  /**
   * Live availability for the username field. Rate-limited because it answers
   * an existence question - generous enough to type against, tight enough that
   * it is not a dictionary scanner.
   */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('handle/available')
  @ApiOperation({ summary: 'Account: is this username free and allowed?' })
  checkHandle(
    @CurrentUser() user: AccountPrincipal,
    @Query() dto: CheckHandleDto,
  ) {
    return this.buyers.checkHandle(user.id, dto.handle);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Patch('handle')
  @ApiOperation({ summary: 'Account: claim or change the public username' })
  setHandle(
    @CurrentUser() user: AccountPrincipal,
    @Body() dto: SetHandleDto,
  ) {
    return this.buyers.setHandle(user.id, dto.handle);
  }

  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post('verify-email/start')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Account: email a code to verify the account's email" })
  startEmailVerification(@CurrentUser() user: AccountPrincipal) {
    return this.buyers.startEmailVerification(user.id);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Account: confirm the emailed code and verify the email' })
  confirmEmailVerification(
    @CurrentUser() user: AccountPrincipal,
    @Body() dto: VerifyCodeDto,
  ) {
    return this.buyers.confirmEmailVerification(user.id, dto.code);
  }
}
