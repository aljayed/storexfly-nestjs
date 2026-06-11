import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AdminRole, ROLES_KEY } from '../decorators/roles.decorator';
import type { AdminPrincipal, RequestWithPrincipal } from '../types/principal';

/**
 * Enforces `@Roles(...)` on admin routes. Must run after `AdminJwtAuthGuard`
 * so `req.user` is populated. No `@Roles` metadata = any authenticated admin.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<AdminRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) {
      return true;
    }
    const request = context
      .switchToHttp()
      .getRequest<RequestWithPrincipal<AdminPrincipal>>();
    const user = request.user;
    if (!user || !required.includes(user.role)) {
      throw new ForbiddenException(
        `Requires one of roles: ${required.join(', ')}`,
      );
    }
    return true;
  }
}
