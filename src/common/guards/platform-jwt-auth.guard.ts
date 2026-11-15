import {
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import type { Request } from 'express';
import { hasGrant, OWNER_ROLE } from '../auth/platform-access';
import {
  PLATFORM_ANY_STAFF,
  PLATFORM_AREA_KEY,
  type PlatformAreaRule,
} from '../decorators/platform-area.decorator';
import type { PlatformPrincipal } from '../types/principal';
import { PlatformAuditService } from '../../modules/platform-audit/platform-audit.service';
import {
  auditAction,
  auditTarget,
} from '../../modules/platform-audit/platform-audit.interceptor';

/**
 * Platform-console guard: validates the staff session JWT, then checks the
 * route's `@PlatformArea` against the staff member's role. Fails closed - a
 * route with no area is owner-only.
 */
@Injectable()
export class PlatformJwtAuthGuard extends AuthGuard('platform-jwt') {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: PlatformAuditService,
  ) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    await super.canActivate(context);
    const req = context
      .switchToHttp()
      .getRequest<
        Request & { user: PlatformPrincipal; platformWorkspace?: string }
      >();
    const user = req.user;
    const targets = [context.getHandler(), context.getClass()];
    const rule = this.reflector.getAllAndOverride<PlatformAreaRule>(
      PLATFORM_AREA_KEY,
      targets,
    );
    if (rule) req.platformWorkspace = rule.workspaces[0];
    if (user.roleKey === OWNER_ROLE) return true;
    if (
      this.reflector.getAllAndOverride<boolean>(PLATFORM_ANY_STAFF, targets)
    ) {
      return true;
    }
    if (!rule) {
      this.denied(context, req, 'owner only');
      throw new ForbiddenException('Only the platform owner can do this');
    }
    const level =
      rule.level ??
      (['GET', 'HEAD'].includes(req.method.toUpperCase()) ? 'view' : 'act');
    if (rule.workspaces.some((w) => hasGrant(user.grants, w, level))) {
      return true;
    }
    this.denied(context, req, `needs ${rule.workspaces.join('|')}.${level}`);
    throw new ForbiddenException(
      level === 'approve'
        ? 'This needs sign-off from a lead of this team'
        : `Your role (${user.roleName}) can't ${level === 'view' ? 'open' : 'change'} this`,
    );
  }

  /** Refused changes are worth a record; refused page loads are not. */
  private denied(
    context: ExecutionContext,
    req: Request & { user: PlatformPrincipal; platformWorkspace?: string },
    why: string,
  ): void {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    void this.audit.record({
      actor: req.user,
      workspace: req.platformWorkspace ?? null,
      action: auditAction(context),
      targetId: auditTarget(req),
      outcome: 'denied',
      statusCode: 403,
      details: { reason: why },
      req,
    });
  }

  handleRequest<T = PlatformPrincipal>(err: unknown, user: unknown): T {
    if (err || !user) {
      throw new UnauthorizedException('Sign in to the platform console');
    }
    return user as T;
  }
}
