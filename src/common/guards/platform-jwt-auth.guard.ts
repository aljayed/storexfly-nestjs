import { ForbiddenException, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { PlatformPrincipal } from '../types/principal';

/** Platform-admin console guard - validates the platform-scoped JWT. */
@Injectable()
export class PlatformJwtAuthGuard extends AuthGuard('platform-jwt') {
  handleRequest<T = PlatformPrincipal>(err: unknown, user: unknown): T {
    if (err || !user) {
      throw new ForbiddenException('Platform admin authentication required');
    }
    return user as T;
  }
}
