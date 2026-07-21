import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseFilters,
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
import { EmailOtpVerifyDto } from './dto/email-otp-verify.dto';
import { LoginDto } from './dto/login.dto';
import { ForgotPasswordDto, ResetPasswordDto } from './dto/password-reset.dto';
import { PhoneStartDto, PhoneVerifyDto } from './dto/phone.dto';
import { RegisterDto } from './dto/register.dto';
import { GoogleOAuthFailureFilter } from './filters/google-oauth-failure.filter';
import { GoogleOAuthGuard } from './guards/google-oauth.guard';
import { PasswordResetService } from './password-reset.service';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
    private readonly passwordReset: PasswordResetService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('register')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Start seller registration (email): sends a verification code',
  })
  registerStart(@Body() dto: RegisterDto) {
    return this.auth.registerStart(dto);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('register/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify the code and complete seller registration' })
  registerVerify(@Body() dto: EmailOtpVerifyDto) {
    return this.auth.registerVerify(dto.email, dto.code);
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
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Email a password-reset link (email accounts)' })
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    await this.passwordReset.request(dto.email);
    // Always 200 with the same shape — never reveal whether the email exists.
    return { ok: true };
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Set a new password using a reset token' })
  async resetPassword(@Body() dto: ResetPasswordDto) {
    await this.passwordReset.reset(dto.token, dto.password);
    return { ok: true };
  }

  @Public()
  @Get('google')
  @UseGuards(GoogleOAuthGuard)
  @UseFilters(GoogleOAuthFailureFilter)
  @ApiOperation({ summary: 'Begin Google OAuth (302 → Google)' })
  googleAuth(): void {}

  @Public()
  @Get('google/callback')
  @UseGuards(GoogleOAuthGuard)
  @UseFilters(GoogleOAuthFailureFilter)
  @ApiOperation({
    summary: 'Google OAuth callback → redirect to Vue with token',
  })
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
