import {
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, count, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { DbExecutor, DrizzleDB } from '../../database/drizzle.types';
import {
  customers,
  orders,
  type CustomerRow,
} from '../../database/schema';
import type { CustomerSegment } from '../../database/schema/enums';
import { OrderResponse } from '../orders/dto/order.response';
import { CustomerListResponse } from './dto/customer-list.response';
import { CustomerResponse } from './dto/customer.response';

export interface RecordOrderInput {
  shopId: string;
  name: string;
  email: string;
  city?: string;
  amountCents: number;
  placedAt: Date;
}

/** Segment thresholds (derived server-side — never trusted from the client). */
const VIP_MIN_ORDERS = 4;
const VIP_MIN_SPEND_CENTS = 20_000; // $200
const REPEAT_MIN_ORDERS = 2;

@Injectable()
export class CustomersService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  /** Lifetime-aggregate driven segmentation. */
  static computeSegment(ordersCount: number, spentCents: number): CustomerSegment {
    if (ordersCount >= VIP_MIN_ORDERS || spentCents >= VIP_MIN_SPEND_CENTS) {
      return 'VIP';
    }
    if (ordersCount >= REPEAT_MIN_ORDERS) {
      return 'Repeat';
    }
    return 'New';
  }

  /**
   * Find-or-create a customer for an incoming order and roll the lifetime
   * aggregates forward. Runs against whichever executor is passed so it can
   * participate in the checkout transaction. Returns the customer id.
   */
  async recordOrder(
    tx: DbExecutor,
    input: RecordOrderInput,
  ): Promise<string> {
    const email = input.email.toLowerCase();
    const existing = await tx.query.customers.findFirst({
      where: and(
        eq(customers.shopId, input.shopId),
        eq(customers.email, email),
      ),
    });

    if (!existing) {
      const segment = CustomersService.computeSegment(1, input.amountCents);
      const [row] = await tx
        .insert(customers)
        .values({
          shopId: input.shopId,
          name: input.name,
          email,
          city: input.city ?? '',
          ordersCount: 1,
          spentCents: input.amountCents,
          firstOrderAt: input.placedAt,
          lastOrderAt: input.placedAt,
          segment,
        })
        .returning({ id: customers.id });
      return row.id;
    }

    const ordersCount = existing.ordersCount + 1;
    const spentCents = existing.spentCents + input.amountCents;
    const lastOrderAt =
      !existing.lastOrderAt || input.placedAt > existing.lastOrderAt
        ? input.placedAt
        : existing.lastOrderAt;
    const firstOrderAt =
      !existing.firstOrderAt || input.placedAt < existing.firstOrderAt
        ? input.placedAt
        : existing.firstOrderAt;

    await tx
      .update(customers)
      .set({
        name: input.name || existing.name,
        city: input.city || existing.city,
        ordersCount,
        spentCents,
        lastOrderAt,
        firstOrderAt,
        segment: CustomersService.computeSegment(ordersCount, spentCents),
      })
      .where(eq(customers.id, existing.id));
    return existing.id;
  }

  /** Adjusts aggregates when an order is refunded (decrements spend). */
  async applyRefund(
    tx: DbExecutor,
    customerId: string,
    amountCents: number,
  ): Promise<void> {
    const customer = await tx.query.customers.findFirst({
      where: eq(customers.id, customerId),
    });
    if (!customer) return;
    const spentCents = Math.max(0, customer.spentCents - amountCents);
    await tx
      .update(customers)
      .set({
        spentCents,
        segment: CustomersService.computeSegment(
          customer.ordersCount,
          spentCents,
        ),
      })
      .where(eq(customers.id, customerId));
  }

  /**
   * Paginated admin list. `total` counts the filtered set; `stats` are
   * shop-wide aggregates so the header KPIs and segment tab counts stay
   * correct regardless of the active page or filter.
   */
  async list(
    shopId: string,
    query: {
      segment?: CustomerSegment;
      q?: string;
      page: number;
      limit: number;
      offset: number;
    },
  ): Promise<CustomerListResponse> {
    const conditions = [eq(customers.shopId, shopId)];
    if (query.segment) conditions.push(eq(customers.segment, query.segment));
    const q = query.q?.trim();
    if (q) {
      const like = `%${q}%`;
      conditions.push(
        or(
          ilike(customers.name, like),
          ilike(customers.email, like),
          ilike(customers.city, like),
        )!,
      );
    }
    const where = and(...conditions);

    const [rows, [{ total }], segmentRows, [aggr]] = await Promise.all([
      this.db.query.customers.findMany({
        where,
        orderBy: [desc(customers.spentCents)],
        limit: query.limit,
        offset: query.offset,
      }),
      this.db.select({ total: count() }).from(customers).where(where),
      this.db
        .select({ segment: customers.segment, n: count() })
        .from(customers)
        .where(eq(customers.shopId, shopId))
        .groupBy(customers.segment),
      this.db
        .select({
          returning: sql<string>`count(*) filter (where ${customers.ordersCount} > 1)`,
          avgSpentCents: sql<string>`coalesce(avg(${customers.spentCents}), 0)`,
        })
        .from(customers)
        .where(eq(customers.shopId, shopId)),
    ]);

    const counts: Record<string, number> = { All: 0 };
    for (const r of segmentRows) {
      counts[r.segment] = r.n;
      counts.All += r.n;
    }

    return {
      data: rows.map(CustomerResponse.fromRow),
      total,
      page: query.page,
      limit: query.limit,
      stats: {
        counts,
        returning: Number(aggr.returning),
        avgLifetime: Math.round(Number(aggr.avgSpentCents)) / 100,
      },
    };
  }

  async getWithHistory(
    shopId: string,
    id: string,
  ): Promise<CustomerResponse & { history: OrderResponse[] }> {
    const customer = await this.requireOwned(shopId, id);
    const history = await this.db.query.orders.findMany({
      where: eq(orders.customerId, id),
      orderBy: [desc(orders.placedAt)],
      with: { items: true },
    });
    return {
      ...CustomerResponse.fromRow(customer),
      history: history.map((o) => OrderResponse.fromRow(o, o.items)),
    };
  }

  private async requireOwned(
    shopId: string,
    id: string,
  ): Promise<CustomerRow> {
    const customer = await this.db.query.customers.findFirst({
      where: and(eq(customers.id, id), eq(customers.shopId, shopId)),
    });
    if (!customer) {
      throw new NotFoundException('Customer not found in this shop');
    }
    return customer;
  }
}
