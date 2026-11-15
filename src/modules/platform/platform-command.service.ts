import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNull,
  lt,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import {
  hasGrant,
  PLATFORM_WORKSPACES,
  type PlatformWorkspace,
} from '../../common/auth/platform-access';
import type { PlatformPrincipal } from '../../common/types/principal';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import {
  faceChecks,
  orders,
  platformSettings,
  shops,
  tradeDisputes,
  users,
} from '../../database/schema';
import { PlatformAuditService } from '../platform-audit/platform-audit.service';

const HOUR = 3600_000;
// Orders the courier holds; no update for this long means someone should look.
const STUCK_AFTER_HOURS = 72;

export interface WorkQueue {
  key: string;
  label: string;
  workspace: PlatformWorkspace;
  to: string;
  open: number;
  oldestAt: string | null;
  /** How long an item may wait before it counts as late. */
  targetHours: number;
  late: number;
}

/**
 * The console's home: what needs a person today across the teams the
 * signed-in staff member works in, plus platform pulse and recent changes for
 * the roles allowed to see them. Every block is filtered by role.
 */
@Injectable()
export class PlatformCommandService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly audit: PlatformAuditService,
  ) {}

  async overview(user: PlatformPrincipal) {
    const can = (w: PlatformWorkspace) => hasGrant(user.grants, w, 'view');
    const [queues, pulse, services, changes] = await Promise.all([
      this.queues(can),
      can('insights') || can('finance') ? this.pulse() : null,
      can('system') || can('orders') ? this.services() : null,
      can('access')
        ? this.audit.recentChanges(8)
        : this.audit.recentChanges(
            8,
            PLATFORM_WORKSPACES.filter((w) => can(w) && w !== 'access'),
          ),
    ]);
    return { queues, pulse, services, changes, generatedAt: new Date() };
  }

  private async queues(
    can: (w: PlatformWorkspace) => boolean,
  ): Promise<WorkQueue[]> {
    const now = Date.now();
    const late = (at: unknown, hours: number) =>
      sql<number>`count(*) filter (where ${at} < ${ts(now - hours * HOUR)})`.mapWith(
        Number,
      );
    const jobs: Promise<WorkQueue>[] = [];

    if (can('sellers')) {
      jobs.push(
        this.db
          .select({
            open: sql<number>`count(*)`.mapWith(Number),
            oldest: sql<Date | null>`min(${shops.kycSubmittedAt})`,
            late: late(shops.kycSubmittedAt, 24),
          })
          .from(shops)
          .where(eq(shops.kycStatus, 'pending'))
          .then(([r]) => ({
            key: 'kyc',
            label: 'Seller verification',
            workspace: 'sellers' as const,
            to: '/platform-admin/kyc',
            open: r.open,
            oldestAt: iso(r.oldest),
            targetHours: 24,
            late: r.late,
          })),
      );
    }
    if (can('risk')) {
      jobs.push(
        this.db
          .select({
            open: sql<number>`count(*)`.mapWith(Number),
            oldest: sql<Date | null>`min(${faceChecks.createdAt})`,
            late: late(faceChecks.createdAt, 12),
          })
          .from(faceChecks)
          .where(
            and(eq(faceChecks.flagged, true), isNull(faceChecks.reviewedAt)),
          )
          .then(([r]) => ({
            key: 'face',
            label: 'Face checks to review',
            workspace: 'risk' as const,
            to: '/platform-admin/face-checks',
            open: r.open,
            oldestAt: iso(r.oldest),
            targetHours: 12,
            late: r.late,
          })),
      );
    }
    if (can('support')) {
      jobs.push(
        this.db
          .select({
            open: sql<number>`count(*)`.mapWith(Number),
            oldest: sql<Date | null>`min(${tradeDisputes.createdAt})`,
            late: late(tradeDisputes.createdAt, 72),
          })
          .from(tradeDisputes)
          .where(ne(tradeDisputes.status, 'resolved'))
          .then(([r]) => ({
            key: 'disputes',
            label: 'Open disputes',
            workspace: 'support' as const,
            to: '/platform-admin/trade-cases',
            open: r.open,
            oldestAt: iso(r.oldest),
            targetHours: 72,
            late: r.late,
          })),
      );
    }
    if (can('orders')) {
      const lastMove = sql`coalesce(${orders.courierStatusAt}, ${orders.handedOverAt}, ${orders.placedAt})`;
      jobs.push(
        this.db
          .select({
            open: sql<number>`count(*)`.mapWith(Number),
            oldest: sql<Date | null>`min(${lastMove})`,
          })
          .from(orders)
          .where(
            and(
              inArray(orders.status, ['HandedOver', 'Shipped']),
              sql`${lastMove} < ${ts(now - STUCK_AFTER_HOURS * HOUR)}`,
            ),
          )
          .then(([r]) => ({
            key: 'stuck',
            label: 'Deliveries with no courier update for 3 days',
            workspace: 'orders' as const,
            to: '/platform-admin/couriers',
            open: r.open,
            oldestAt: iso(r.oldest),
            targetHours: STUCK_AFTER_HOURS,
            late: r.open,
          })),
      );
    }
    return Promise.all(jobs);
  }

  private async pulse() {
    const startOfDay = new Date();
    // Dhaka midnight: the platform's trading day.
    startOfDay.setUTCHours(-6, 0, 0, 0);
    if (startOfDay.getTime() > Date.now())
      startOfDay.setUTCDate(startOfDay.getUTCDate() - 1);
    const weekAgo = new Date(Date.now() - 7 * 24 * HOUR);
    const [[today], [lastWeek], [shopCounts]] = await Promise.all([
      this.db
        .select({
          orders: sql<number>`count(*)`.mapWith(Number),
          salesCents:
            sql<number>`coalesce(sum(${orders.totalCents}), 0)`.mapWith(Number),
        })
        .from(orders)
        .where(
          and(gte(orders.placedAt, startOfDay), ne(orders.status, 'Cancelled')),
        ),
      this.db
        .select({
          orders: sql<number>`count(*)`.mapWith(Number),
          salesCents:
            sql<number>`coalesce(sum(${orders.totalCents}), 0)`.mapWith(Number),
        })
        .from(orders)
        .where(
          and(
            gte(
              orders.placedAt,
              new Date(startOfDay.getTime() - 7 * 24 * HOUR),
            ),
            lt(orders.placedAt, new Date(Date.now() - 7 * 24 * HOUR)),
            ne(orders.status, 'Cancelled'),
          ),
        ),
      this.db
        .select({
          total: sql<number>`count(*)`.mapWith(Number),
          newThisWeek:
            sql<number>`count(*) filter (where ${shops.createdAt} >= ${ts(weekAgo.getTime())})`.mapWith(
              Number,
            ),
          suspended:
            sql<number>`count(*) filter (where ${shops.suspendedAt} is not null)`.mapWith(
              Number,
            ),
        })
        .from(shops),
    ]);
    const [inFlight] = await this.db
      .select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(orders)
      .where(
        inArray(orders.status, [
          'New',
          'Confirmed',
          'Packed',
          'HandedOver',
          'Shipped',
        ]),
      );
    return {
      today,
      sameTimeLastWeek: lastWeek,
      ordersInFlight: inFlight.n,
      shops: shopCounts,
    };
  }

  private async services() {
    const [s] = await this.db
      .select({
        bkash: platformSettings.bkashEnabled,
        bkashSandbox: platformSettings.bkashSandbox,
        ssl: platformSettings.sslcommerzEnabled,
        sslSandbox: platformSettings.sslcommerzSandbox,
        carrybee: platformSettings.carrybeeEnabled,
        carrybeeProduction: platformSettings.carrybeeProduction,
      })
      .from(platformSettings)
      .limit(1);
    const state = (on?: boolean, test?: boolean) =>
      !on ? 'off' : test ? 'test' : 'live';
    return [
      {
        key: 'bkash',
        label: 'bKash payments',
        state: state(s?.bkash, s?.bkashSandbox),
        to: '/platform-admin/payments',
      },
      {
        key: 'sslcommerz',
        label: 'SSLCommerz payments',
        state: state(s?.ssl, s?.sslSandbox),
        to: '/platform-admin/payments',
      },
      {
        key: 'carrybee',
        label: 'CarryBee courier',
        state: state(s?.carrybee, !s?.carrybeeProduction),
        to: '/platform-admin/couriers',
      },
    ];
  }

  /**
   * One box, every record type the staff member may open: shops, buyers and
   * orders. Short queries only match from the start, to stay fast.
   */
  async search(user: PlatformPrincipal, raw: string) {
    const q = raw.trim().slice(0, 80);
    if (q.length < 2) return { shops: [], buyers: [], orders: [] };
    const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const can = (w: PlatformWorkspace) => hasGrant(user.grants, w, 'view');
    const [shopRows, buyerRows, orderRows] = await Promise.all([
      can('sellers')
        ? this.db
            .select({
              id: shops.id,
              name: shops.name,
              handle: shops.handle,
              kycStatus: shops.kycStatus,
              suspendedAt: shops.suspendedAt,
            })
            .from(shops)
            .where(or(ilike(shops.name, like), ilike(shops.handle, like)))
            .orderBy(shops.name)
            .limit(6)
        : [],
      can('support')
        ? this.db
            .select({
              id: users.id,
              name: users.name,
              email: users.email,
              phone: users.phone,
            })
            .from(users)
            .where(
              or(
                ilike(users.name, like),
                ilike(users.email, like),
                ilike(users.phone, like),
              ),
            )
            .orderBy(users.name)
            .limit(6)
        : [],
      can('orders') || can('support')
        ? this.db
            .select({
              id: orders.id,
              reference: orders.reference,
              status: orders.status,
              totalCents: orders.totalCents,
              customerName: orders.customerName,
              shopId: orders.shopId,
              shopName: shops.name,
              placedAt: orders.placedAt,
            })
            .from(orders)
            .innerJoin(shops, eq(shops.id, orders.shopId))
            .where(
              or(
                ilike(orders.reference, like),
                ilike(orders.phone, like),
                ilike(orders.email, like),
              ),
            )
            .orderBy(desc(orders.placedAt))
            .limit(6)
        : [],
    ]);
    return { shops: shopRows, buyers: buyerRows, orders: orderRows };
  }
}

/**
 * A timestamp parameter for raw `sql` fragments. postgres-js cannot infer a
 * type for a bare Date outside a column comparison, so send ISO text and cast.
 */
function ts(ms: number) {
  return sql`${new Date(ms).toISOString()}::timestamptz`;
}

function iso(d: Date | string | null): string | null {
  if (!d) return null;
  return new Date(d).toISOString();
}
