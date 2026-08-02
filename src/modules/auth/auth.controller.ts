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
import {
  VerifyEmailConfirmDto,
  VerifyEmailStartDto,
  VerifyPhoneConfirmDto,
  VerifyPhoneStartDto,
} from './dto/verify-contact.dto';
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
    // Always 200 with the same shape - never reveal whether the email exists.
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

  // ── Contact verification (required before creating a shop) ──
  @ApiBearerAuth()
  @Get('verify/status')
  @ApiOperation({
    summary:
      'Which contact details the account has verified (shop-creation gate)',
  })
  verifyStatus(@CurrentUser() user: SellerPrincipal) {
    return this.auth.contactStatus(user.id);
  }

  @ApiBearerAuth()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('verify/phone/start')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Send an OTP to a phone number the signed-in account wants to verify',
  })
  verifyPhoneStart(
    @CurrentUser() user: SellerPrincipal,
    @Body() dto: VerifyPhoneStartDto,
  ) {
    return this.auth.startPhoneVerification(user.id, dto.phone);
  }

  @ApiBearerAuth()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('verify/phone/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Confirm the phone OTP and mark the number verified',
  })
  @ApiOkResponse({ type: UserResponse })
  verifyPhoneConfirm(
    @CurrentUser() user: SellerPrincipal,
    @Body() dto: VerifyPhoneConfirmDto,
  ) {
    return this.auth.confirmPhoneVerification(user.id, dto.phone, dto.code);
  }

  @ApiBearerAuth()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('verify/email/start')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Email an OTP to an address the signed-in account wants to verify',
  })
  verifyEmailStart(
    @CurrentUser() user: SellerPrincipal,
    @Body() dto: VerifyEmailStartDto,
  ) {
    return this.auth.startEmailVerification(user.id, dto.email);
  }

  @ApiBearerAuth()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('verify/email/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Confirm the emailed OTP and mark the email verified',
  })
  @ApiOkResponse({ type: UserResponse })
  verifyEmailConfirm(
    @CurrentUser() user: SellerPrincipal,
    @Body() dto: VerifyEmailConfirmDto,
  ) {
    return this.auth.confirmEmailVerification(user.id, dto.email, dto.code);
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
  @ApiOperation({ summary: 'Logout (stateless - client discards token)' })
  logout() {
    return { ok: true };
  }
}
