import {
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { AdminPrincipal } from '../types/principal';

/**
 * Admin-console guard. Validates the admin-scoped JWT (issued only after the
 * 2FA step) and additionally asserts the `twoFactorVerified` claim, so a token
 * minted before 2FA can never reach a protected admin route.
 */
@Injectable()
export class AdminJwtAuthGuard extends AuthGuard('admin-jwt') {
  handleRequest<T = AdminPrincipal>(err: unknown, user: unknown): T {
    if (err || !user) {
      throw new ForbiddenException('Admin authentication required');
    }
    const principal = user as AdminPrincipal;
    if (!principal.twoFactorVerified) {
      throw new ForbiddenException('Two-factor verification required');
    }
    return principal as T;
  }
}
