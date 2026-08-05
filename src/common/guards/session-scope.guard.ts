import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { STOREFRONT_SESSION_KEY } from '../decorators/storefront-session.decorator';
import type { Principal, RequestWithPrincipal } from '../types/principal';

/**
 * Keeps a frictionless storefront session out of the seller-side API.
 *
 * Buyer and seller are one `users` account, so the separation that matters is
 * not two tables but two session scopes: an account created inline at checkout
 * has proved nothing, and its token must not double as a seller credential.
 * This guard runs globally right after the account JWT guard and refuses any
 * authenticated route that is not explicitly marked `@StorefrontSession()`.
 *
 * Routes reached with the admin-console or platform token are untouched - they
 * are separate identities with their own guards - and so are `@Public()` routes,
 * which have no principal by the time this runs.
 */
@Injectable()
export class SessionScopeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<RequestWithPrincipal<Principal>>();
    const user = request.user;
    // No principal (public route) or a different identity entirely - not ours.
    if (!user || user.kind !== 'seller' || user.scope !== 'storefront') {
      return true;
    }
    const allowed = this.reflector.getAllAndOverride<boolean>(
      STOREFRONT_SESSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (allowed) {
      return true;
    }
    throw new ForbiddenException({
      code: 'VERIFICATION_REQUIRED',
      message:
        'Verify your email or phone number to use this part of your account.',
    });
  }
}
