import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import type { PlatformPrincipal } from '../../common/types/principal';
import { PlatformAuditService, redact } from './platform-audit.service';

type PlatformRequest = Request & {
  user?: PlatformPrincipal;
  platformWorkspace?: string;
};

/** "PlatformCouponsController" + "update" -> "coupons.update" */
export function auditAction(context: ExecutionContext): string {
  const noun = context
    .getClass()
    .name.replace(/^Platform/, '')
    .replace(/Controller$/, '');
  const area = noun.charAt(0).toLowerCase() + noun.slice(1);
  return `${area || 'platform'}.${context.getHandler().name}`;
}

/** The most specific route param - usually the record being changed. */
export function auditTarget(req: Request): string | null {
  const values = Object.values(req.params ?? {}).filter(Boolean);
  return values.length ? values.map(String).join('/') : null;
}

/**
 * Writes one audit record for every change a platform staff member makes -
 * any non-GET request authenticated as a platform principal - with the
 * outcome and the (redacted) request body. Applied app-wide; does nothing for
 * sellers, buyers or shop-admin staff.
 */
@Injectable()
export class PlatformAuditInterceptor implements NestInterceptor {
  constructor(private readonly audit: PlatformAuditService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<PlatformRequest>();
    const user = req.user;
    if (
      user?.kind !== 'platform' ||
      ['GET', 'HEAD', 'OPTIONS'].includes(req.method)
    ) {
      return next.handle();
    }
    const base = {
      actor: user,
      workspace: req.platformWorkspace ?? null,
      action: auditAction(context),
      targetId: auditTarget(req),
      details: { body: redact(req.body), query: redact(req.query) } as Record<
        string,
        unknown
      >,
      req,
    };
    return next.handle().pipe(
      tap({
        next: () => {
          void this.audit.record({ ...base, outcome: 'ok', statusCode: 200 });
        },
        error: (err: unknown) => {
          const status =
            typeof err === 'object' && err !== null && 'status' in err
              ? Number((err as { status: number }).status)
              : 500;
          void this.audit.record({
            ...base,
            outcome: status === 403 ? 'denied' : 'failed',
            statusCode: status,
            details: {
              ...base.details,
              error: (err as Error)?.message?.slice(0, 300),
            },
          });
        },
      }),
    );
  }
}
