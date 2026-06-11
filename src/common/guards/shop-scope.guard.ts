import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { AdminPrincipal, RequestWithPrincipal } from '../types/principal';

/**
 * Tenant-isolation guard for admin routes carrying a `:shopId` (or `:id` on
 * `/shops/:id/...`) path param. Ensures a staff member can only ever touch the
 * shop their token is scoped to, regardless of role. Run after the admin JWT
 * guard.
 */
@Injectable()
export class ShopScopeGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<RequestWithPrincipal<AdminPrincipal>>();
    const user = request.user;
    const params = request.params as Record<string, string>;
    const shopParam = params.shopId ?? params.id;

    if (shopParam && user?.shopId && shopParam !== user.shopId) {
      throw new ForbiddenException('You do not have access to this shop');
    }
    return true;
  }
}
