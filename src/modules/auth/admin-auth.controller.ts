import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { permissionsForRole } from '../../common/auth/admin-permissions';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { AdminJwtAuthGuard } from '../../common/guards/admin-jwt-auth.guard';
import type {
  AdminPrincipal,
  SellerPrincipal,
} from '../../common/types/principal';
import { AdminAuthService } from './admin-auth.service';
import {
  AdminLoginDto,
  AdminSessionDto,
  AdminTwoFactorDto,
} from './dto/admin-login.dto';
import { SetPasswordDto } from './dto/set-password.dto';

@ApiTags('admin-auth')
@Controller('auth/admin')
export class AdminAuthController {
  constructor(private readonly adminAuth: AdminAuthService) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Admin login stage 1 - credentials → 2FA ticket' })
  login(@Body() dto: AdminLoginDto) {
    return this.adminAuth.login(dto);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('2fa')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Admin login stage 2 - verify TOTP → console JWT' })
  verify(@Body() dto: AdminTwoFactorDto) {
    return this.adminAuth.verifyTwoFactor(dto);
  }

  // `@Public()` exempts the route from the global seller JwtAuthGuard, which
  // would otherwise verify the admin token against the seller secret and 401.
  // The route-level AdminJwtAuthGuard still enforces a valid, 2FA-verified admin
  // token - see the same pairing on the admin-scoped shop controllers.
  @Public()
  @ApiBearerAuth()
  @UseGuards(AdminJwtAuthGuard)
  @Get('me')
  @ApiOperation({ summary: 'Hydrate the current admin principal' })
  me(@CurrentUser() admin: AdminPrincipal) {
    return { ...admin, permissions: permissionsForRole(admin.role) };
  }

  /**
   * The console's own password controls. A staffer who signed in here directly
   * has no account token, and an owner's password lives on their Hoomri
   * account, so both are resolved from the console session instead of asking
   * the profile page to know the difference.
   */
  @Public()
  @ApiBearerAuth()
  @UseGuards(AdminJwtAuthGuard)
  @Get('password')
  @ApiOperation({ summary: 'Whether this console sign-in has a password yet' })
  passwordState(@CurrentUser() admin: AdminPrincipal) {
    return this.adminAuth.passwordState(admin);
  }

  @Public()
  @ApiBearerAuth()
  @UseGuards(AdminJwtAuthGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Set or change the console sign-in password' })
  setPassword(
    @CurrentUser() admin: AdminPrincipal,
    @Body() dto: SetPasswordDto,
  ) {
    return this.adminAuth.setPassword(admin, dto);
  }

  /**
   * Elevate an authenticated seller session to an admin session, or switch the
   * active shop of an existing one. Optional `shopId` selects which owned shop
   * to open (defaults to the most recent).
   */
  @ApiBearerAuth()
  @Post('session')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Auto-elevate / switch shop → admin JWT (no 2FA)' })
  session(
    @CurrentUser() seller: SellerPrincipal,
    @Body() body: AdminSessionDto,
  ) {
    return this.adminAuth.sellerSession(
      seller.id,
      seller.email ?? '',
      seller.name,
      body?.shopId,
    );
  }
}
