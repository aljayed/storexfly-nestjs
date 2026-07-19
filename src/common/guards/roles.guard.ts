import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AdminPermission } from '../auth/admin-permissions';
import { roleHasPermission } from '../auth/admin-permissions';
import { AdminRole, PERMS_KEY, ROLES_KEY } from '../decorators/roles.decorator';
import type { AdminPrincipal, RequestWithPrincipal } from '../types/principal';

/**
 * Enforces `@Roles(...)` and `@RequirePerm(...)` on admin routes. Must run
 * after `AdminJwtAuthGuard` so `req.user` is populated. No metadata = any
 * authenticated admin.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<AdminRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const perms = this.reflector.getAllAndOverride<AdminPermission[]>(
      PERMS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required?.length && !perms?.length) {
      return true;
    }
    const request = context
      .switchToHttp()
      .getRequest<RequestWithPrincipal<AdminPrincipal>>();
    const user = request.user;
    if (!user) {
      throw new ForbiddenException('Not authenticated as an admin');
    }
    if (required?.length && !required.includes(user.role)) {
      throw new ForbiddenException(
        `Requires one of roles: ${required.join(', ')}`,
      );
    }
    if (perms?.length && !perms.every((p) => roleHasPermission(user.role, p))) {
      throw new ForbiddenException(
        'Your access level does not allow this action',
      );
    }
    return true;
  }
}
