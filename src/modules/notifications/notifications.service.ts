import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, or, sql } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { DbExecutor, DrizzleDB } from '../../database/drizzle.types';
import {
  buyerNotifications,
  buyers,
  shops,
  type OrderRow,
} from '../../database/schema';

/** Reduce any BD phone format to the bare national number (same rule as BuyerService). */
function normalizePhone(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\D/g, '').replace(/^880/, '').replace(/^0+/, '');
}

export interface BuyerNotificationView {
  id: string;
  type: string;
  title: string;
  body: string;
  orderReference: string | null;
  shopName: string | null;
  shopHandle: string | null;
  read: boolean;
  createdAt: string;
}

/**
 * In-app buyer notifications, surfaced on the buyer profile. Order events are
 * matched to a buyer account by the order's email or phone; guest orders with
 * no matching account simply produce no notification. Emitting never throws —
 * a notification must not be able to fail an order.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  /**
   * Record an order event for the buyer who placed it (if they have an
   * account). Runs on `executor` so callers inside a transaction notify
   * atomically with the order change itself.
   */
  async orderEvent(
    executor: DbExecutor,
    order: Pick<OrderRow, 'id' | 'shopId' | 'reference' | 'email' | 'phone'>,
    type:
      | 'order_placed'
      | 'order_status'
      | 'order_cancelled'
      | 'order_refunded'
      | 'payment_confirmed',
    title: string,
    body: string,
  ): Promise<void> {
    try {
      const phone = normalizePhone(order.phone);
      const buyer = await executor.query.buyers.findFirst({
        where: phone
          ? or(eq(buyers.email, order.email), eq(buyers.phone, phone))
          : eq(buyers.email, order.email),
        columns: { id: true },
      });
      if (!buyer) return;
      const shop = await executor.query.shops.findFirst({
        where: eq(shops.id, order.shopId),
        columns: { name: true, handle: true },
      });
      await executor.insert(buyerNotifications).values({
        buyerId: buyer.id,
        orderId: order.id,
        shopId: order.shopId,
        type,
        title,
        body,
        orderReference: order.reference,
        shopName: shop?.name ?? null,
        shopHandle: shop?.handle ?? null,
      });
    } catch (err) {
      this.logger.warn(
        `Failed to record ${type} notification for order ${order.reference}`,
        err as Error,
      );
    }
  }

  /** Newest-first list plus the unread count for the profile badge. */
  async listForBuyer(
    buyerId: string,
    limit = 50,
  ): Promise<{ notifications: BuyerNotificationView[]; unread: number }> {
    const [rows, [{ unread }]] = await Promise.all([
      this.db.query.buyerNotifications.findMany({
        where: eq(buyerNotifications.buyerId, buyerId),
        orderBy: [desc(buyerNotifications.createdAt)],
        limit,
      }),
      this.db
        .select({ unread: sql<number>`count(*)::int` })
        .from(buyerNotifications)
        .where(
          and(
            eq(buyerNotifications.buyerId, buyerId),
            eq(buyerNotifications.read, false),
          ),
        ),
    ]);
    return {
      notifications: rows.map((n) => ({
        id: n.id,
        type: n.type,
        title: n.title,
        body: n.body,
        orderReference: n.orderReference,
        shopName: n.shopName,
        shopHandle: n.shopHandle,
        read: n.read,
        createdAt: n.createdAt.toISOString(),
      })),
      unread: Number(unread),
    };
  }

  async markAllRead(buyerId: string): Promise<{ ok: true }> {
    await this.db
      .update(buyerNotifications)
      .set({ read: true })
      .where(
        and(
          eq(buyerNotifications.buyerId, buyerId),
          eq(buyerNotifications.read, false),
        ),
      );
    return { ok: true };
  }
}
