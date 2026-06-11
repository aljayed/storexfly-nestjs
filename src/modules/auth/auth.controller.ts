import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import type {
  RequestWithPrincipal,
  SellerPrincipal,
} from '../../common/types/principal';
import type { UserRow } from '../../database/schema';
import { UserResponse } from '../users/dto/user.response';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { PhoneStartDto, PhoneVerifyDto } from './dto/phone.dto';
import { RegisterDto } from './dto/register.dto';
import { GoogleOAuthGuard } from './guards/google-oauth.guard';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('register')
  @ApiOperation({ summary: 'Register a seller account (email)' })
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign in a seller account (email)' })
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('phone/start')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send a phone OTP' })
  startPhone(@Body() dto: PhoneStartDto) {
    return this.auth.startPhone(dto.phone);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('phone/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify a phone OTP and sign in' })
  verifyPhone(@Body() dto: PhoneVerifyDto) {
    return this.auth.verifyPhone(dto.phone, dto.code);
  }

  @Public()
  @Get('google')
  @UseGuards(GoogleOAuthGuard)
  @ApiOperation({ summary: 'Begin Google OAuth (302 → Google)' })
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  googleAuth(): void {}

  @Public()
  @Get('google/callback')
  @UseGuards(GoogleOAuthGuard)
  @ApiOperation({ summary: 'Google OAuth callback → redirect to Vue with token' })
  async googleCallback(
    @Req() req: RequestWithPrincipal,
    @Res() res: Response,
  ): Promise<void> {
    // Passport places the upserted UserRow on req.user for this route.
    const { token } = await this.auth.issueForUser(
      req.user as unknown as UserRow,
    );
    const redirect = this.config.getOrThrow<string>('google.successRedirect');
    const url = new URL(redirect);
    url.searchParams.set('token', token);
    res.redirect(url.toString());
  }

  @ApiBearerAuth()
  @Get('me')
  @ApiOperation({ summary: 'Hydrate the current seller principal' })
  @ApiOkResponse({ type: UserResponse })
  me(@CurrentUser() user: SellerPrincipal) {
    return this.auth.me(user.id);
  }

  @ApiBearerAuth()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Logout (stateless — client discards token)' })
  logout() {
    return { ok: true };
  }
}
