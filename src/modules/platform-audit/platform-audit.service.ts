import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, gte, ilike, lt, or, sql, type SQL } from 'drizzle-orm';
import type { Request } from 'express';
import type { PlatformPrincipal } from '../../common/types/principal';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import { platformAuditLog } from '../../database/schema';

export interface AuditEntry {
  actor?: Pick<PlatformPrincipal, 'id' | 'name' | 'email' | 'roleName'> | null;
  /** For sign-in attempts, which have no actor yet. */
  actorEmail?: string;
  workspace?: string | null;
  action: string;
  method?: string;
  path?: string;
  targetId?: string | null;
  outcome?: 'ok' | 'failed' | 'denied';
  statusCode?: number;
  details?: Record<string, unknown> | null;
  req?: Request;
}

export interface AuditQuery {
  q?: string;
  workspace?: string;
  actorId?: string;
  outcome?: string;
  before?: string;
  limit?: number;
}

// Field names whose values never reach the log.
const SECRET =
  /pass|secret|token|key|otp|code$|dataurl|proof|receipt|document|file|image|photo|signature/i;
const MAX_STRING = 300;

/** Copies a request body with secrets masked and long values cut short. */
export function redact(value: unknown, depth = 0): unknown {
  if (value == null || depth > 4) return value ?? null;
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((v) => redact(v, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] =
        SECRET.test(k) && v != null && v !== ''
          ? '[hidden]'
          : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Writes and reads the platform console's audit log. Writing never throws
 * into the request that triggered it - a failed audit write is logged loudly
 * instead, because refusing a payout because the log hiccupped helps nobody.
 */
@Injectable()
export class PlatformAuditService {
  private readonly logger = new Logger('PlatformAudit');

  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async record(entry: AuditEntry): Promise<void> {
    try {
      const ua = entry.req?.headers['user-agent'];
      await this.db.insert(platformAuditLog).values({
        actorId: entry.actor?.id ?? null,
        actorName: entry.actor?.name ?? null,
        actorEmail: entry.actor?.email ?? entry.actorEmail ?? null,
        actorRole: entry.actor?.roleName ?? null,
        workspace: entry.workspace ?? null,
        action: entry.action.slice(0, 120),
        method: entry.method ?? entry.req?.method ?? null,
        path:
          (entry.path ?? entry.req?.originalUrl ?? '')
            .split('?')[0]
            .slice(0, 300) || null,
        targetId: entry.targetId?.slice(0, 120) ?? null,
        outcome: entry.outcome ?? 'ok',
        statusCode: entry.statusCode ?? null,
        details: entry.details ?? null,
        ip: entry.req?.ip?.slice(0, 64) ?? null,
        userAgent: typeof ua === 'string' ? ua.slice(0, 300) : null,
      });
    } catch (err) {
      this.logger.error(
        `Audit write failed for ${entry.action}: ${(err as Error).message}`,
      );
    }
  }

  async list(query: AuditQuery) {
    const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 200);
    const where: SQL[] = [];
    if (query.workspace)
      where.push(eq(platformAuditLog.workspace, query.workspace));
    if (query.actorId) where.push(eq(platformAuditLog.actorId, query.actorId));
    if (query.outcome && ['ok', 'failed', 'denied'].includes(query.outcome)) {
      where.push(eq(platformAuditLog.outcome, query.outcome as 'ok'));
    }
    if (query.before) {
      const before = new Date(query.before);
      if (!Number.isNaN(before.getTime()))
        where.push(lt(platformAuditLog.createdAt, before));
    }
    const q = query.q?.trim();
    if (q) {
      const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
      where.push(
        or(
          ilike(platformAuditLog.action, like),
          ilike(platformAuditLog.actorName, like),
          ilike(platformAuditLog.actorEmail, like),
          ilike(platformAuditLog.targetId, like),
          ilike(platformAuditLog.path, like),
        )!,
      );
    }
    const rows = await this.db
      .select()
      .from(platformAuditLog)
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(platformAuditLog.createdAt))
      .limit(limit + 1);
    return {
      entries: rows.slice(0, limit),
      nextBefore: rows.length > limit ? rows[limit - 1].createdAt : null,
    };
  }

  /** Changes made in the last day, for the command center. */
  async recentChanges(limit = 8, workspaces?: string[]) {
    const since = new Date(Date.now() - 24 * 3600_000);
    const where: SQL[] = [
      gte(platformAuditLog.createdAt, since),
      sql`${platformAuditLog.method} <> 'GET'`,
      // Sign-ins live in the full log; the home page shows real changes.
      sql`${platformAuditLog.action} not like 'auth.%'`,
    ];
    if (workspaces) {
      if (!workspaces.length) return [];
      where.push(sql`${platformAuditLog.workspace} in ${workspaces}`);
    }
    return this.db
      .select()
      .from(platformAuditLog)
      .where(and(...where))
      .orderBy(desc(platformAuditLog.createdAt))
      .limit(limit);
  }
}
