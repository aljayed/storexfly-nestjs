import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, count, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { centsToDollars } from '../../common/utils/money.util';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import {
  orderItems,
  orders,
  products,
  shops,
  type OrderRow,
} from '../../database/schema';
import type { OrderStatus, SalesChannel } from '../../database/schema/enums';
import { CustomersService } from '../customers/customers.service';
import { PaymentMethodsService } from '../settlements/payment-methods.service';
import type { CheckoutDto } from './dto/checkout.dto';
import { CheckoutResultResponse } from './dto/checkout-result.response';
import { OrderListResponse } from './dto/order-list.response';
import { OrderResponse } from './dto/order.response';

/** Allowed forward transitions for the order pipeline. */
const STATUS_FLOW: Record<OrderStatus, OrderStatus | null> = {
  New: 'Packed',
  Packed: 'Shipped',
  Shipped: 'Delivered',
  Delivered: null,
};

@Injectable()
export class OrdersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly customers: CustomersService,
    private readonly paymentMethods: PaymentMethodsService,
  ) {}

  /**
   * Inline product-page checkout. Runs in a transaction: validates stock,
   * computes totals server-side, allocates a per-shop reference, decrements
   * stock, rolls the customer aggregates forward, and persists the order +
   * line item atomically.
   */
  async checkout(dto: CheckoutDto): Promise<CheckoutResultResponse> {
    // The catalog is platform-managed: the code must be live right now, so a
    // method removed by an operator disappears from checkout immediately.
    const method = await this.paymentMethods.findEnabledByCode(
      dto.paymentMethod,
    );
    if (!method) {
      throw new BadRequestException(
        'That payment method is not available — please pick another.',
      );
    }
    return this.db.transaction(async (tx) => {
      // A switched-off shop is closed to buyers — no orders either.
      const shop = await tx.query.shops.findFirst({
        where: eq(shops.id, dto.shopId),
        columns: { live: true },
      });
      if (!shop?.live) {
        throw new ForbiddenException('This shop is currently offline.');
      }

      const product = await tx.query.products.findFirst({
        where: and(
          eq(products.id, dto.productId),
          eq(products.shopId, dto.shopId),
        ),
      });
      if (!product) {
        throw new NotFoundException('Product not found in this shop');
      }
      // Showcase items are advertised only — the sale happens offline, so
      // online checkout is never allowed for them.
      if (product.listingType === 'showcase') {
        throw new ConflictException(
          'This item cannot be ordered online — please contact the seller.',
        );
      }
      if (product.stock < dto.qty) {
        throw new ConflictException('Not enough stock for this quantity');
      }
      // Sellers toggle payment *kinds* per product (COD / mobile banking /
      // card); the picked method must belong to an allowed kind.
      if (!product.paymentMethods.includes(method.kind)) {
        throw new BadRequestException(
          'This item cannot be paid with that method — please pick another.',
        );
      }

      const hasLocation = Boolean(dto.address.line?.trim() || dto.address.geo);
      if (
        !dto.contact.name.trim() ||
        !dto.contact.phone.trim() ||
        !hasLocation
      ) {
        throw new BadRequestException(
          'Name, phone and a delivery address (or map pin) are required',
        );
      }

      const totalCents = product.priceCents * dto.qty;
      const placedAt = new Date();

      const reference = await this.nextReference(tx, dto.shopId);

      await tx
        .update(products)
        .set({ stock: product.stock - dto.qty })
        .where(eq(products.id, product.id));

      const customerId = await this.customers.recordOrder(tx, {
        shopId: dto.shopId,
        name: dto.contact.name,
        email: dto.contact.email ?? `${dto.contact.phone}@phone.local`,
        city: dto.address.area,
        amountCents: totalCents,
        placedAt,
      });

      const [order] = await tx
        .insert(orders)
        .values({
          reference,
          shopId: dto.shopId,
          customerId,
          customerName: dto.contact.name,
          email: dto.contact.email ?? `${dto.contact.phone}@phone.local`,
          phone: dto.contact.phone,
          qty: dto.qty,
          totalCents,
          status: 'New',
          pay: 'Paid',
          paymentMethod: dto.paymentMethod,
          mobileBankApp: dto.mobileBankApp,
          channel: 'Store',
          address: {
            line: dto.address.line,
            area: dto.address.area,
            pincode: dto.address.pincode,
            geo: dto.address.geo as never,
          },
          placedAt,
        })
        .returning();

      await tx.insert(orderItems).values({
        orderId: order.id,
        productId: product.id,
        name: product.name,
        qty: dto.qty,
        unitPriceCents: product.priceCents,
      });

      return {
        orderId: order.reference,
        total: totalCents / 100,
        paymentMethod: dto.paymentMethod,
        qty: dto.qty,
        eta: 'Tomorrow, by 7 PM',
      };
    });
  }

  /**
   * Paginated admin list. `total` counts the filtered set; `stats` are
   * shop-wide aggregates (one grouped query) so tab counts and KPI cards
   * stay correct regardless of the active page or filter.
   */
  async list(
    shopId: string,
    query: {
      status?: OrderStatus;
      channel?: SalesChannel;
      q?: string;
      sort?: 'newest' | 'oldest' | 'total';
      page: number;
      limit: number;
      offset: number;
    },
  ): Promise<OrderListResponse> {
    const conditions = [eq(orders.shopId, shopId)];
    if (query.status) conditions.push(eq(orders.status, query.status));
    if (query.channel) conditions.push(eq(orders.channel, query.channel));
    const q = query.q?.trim();
    if (q) {
      const like = `%${q}%`;
      conditions.push(
        or(
          ilike(orders.reference, like),
          ilike(orders.customerName, like),
          ilike(orders.email, like),
        )!,
      );
    }
    const where = and(...conditions);

    const orderBy =
      query.sort === 'oldest'
        ? [asc(orders.placedAt)]
        : query.sort === 'total'
          ? [desc(orders.totalCents)]
          : [desc(orders.placedAt)];

    const [rows, [{ total }], statusRows, [money]] = await Promise.all([
      this.db.query.orders.findMany({
        where,
        orderBy,
        limit: query.limit,
        offset: query.offset,
        with: { items: true },
      }),
      this.db.select({ total: count() }).from(orders).where(where),
      this.db
        .select({ status: orders.status, n: count() })
        .from(orders)
        .where(eq(orders.shopId, shopId))
        .groupBy(orders.status),
      this.db
        .select({
          revenueCents: sql<string>`coalesce(sum(${orders.totalCents}) filter (where ${orders.pay} = 'Paid'), 0)`,
          paidCount: sql<string>`count(*) filter (where ${orders.pay} = 'Paid')`,
          refunded: sql<string>`count(*) filter (where ${orders.pay} = 'Refunded')`,
        })
        .from(orders)
        .where(eq(orders.shopId, shopId)),
    ]);

    const counts: Record<string, number> = { All: 0 };
    for (const r of statusRows) {
      counts[r.status] = r.n;
      counts.All += r.n;
    }
    const revenueCents = Number(money.revenueCents);
    const paidCount = Number(money.paidCount);

    return {
      data: rows.map((o) => OrderResponse.fromRow(o, o.items)),
      total,
      page: query.page,
      limit: query.limit,
      stats: {
        counts,
        revenue: centsToDollars(revenueCents),
        avgOrderValue:
          paidCount > 0
            ? centsToDollars(Math.round(revenueCents / paidCount))
            : 0,
        refunded: Number(money.refunded),
      },
    };
  }

  /**
   * The public contract addresses orders by their human reference ("#1042" —
   * the `id` in OrderResponse); the internal uuid is also accepted.
   */
  private orderIdFilter(shopId: string, id: string) {
    return and(
      eq(orders.shopId, shopId),
      id.startsWith('#') ? eq(orders.reference, id) : eq(orders.id, id),
    );
  }

  async getById(shopId: string, id: string): Promise<OrderResponse> {
    const order = await this.db.query.orders.findFirst({
      where: this.orderIdFilter(shopId, id),
      with: { items: true },
    });
    if (!order) {
      throw new NotFoundException('Order not found');
    }
    return OrderResponse.fromRow(order, order.items);
  }

  /** Advance the pipeline New→Packed→Shipped→Delivered (one step at a time). */
  async updateStatus(
    shopId: string,
    id: string,
    next: OrderStatus,
  ): Promise<OrderResponse> {
    const order = await this.requireOwned(shopId, id);
    const allowedNext = STATUS_FLOW[order.status];
    if (next !== allowedNext) {
      throw new BadRequestException(
        `Cannot move an order from ${order.status} to ${next}`,
      );
    }
    const [row] = await this.db
      .update(orders)
      .set({ status: next })
      .where(eq(orders.id, order.id))
      .returning();
    const items = await this.db.query.orderItems.findMany({
      where: eq(orderItems.orderId, order.id),
    });
    return OrderResponse.fromRow(row, items);
  }

  /** Refund an order and unwind its contribution to the customer's spend. */
  async refund(shopId: string, id: string): Promise<OrderResponse> {
    return this.db.transaction(async (tx) => {
      const order = await tx.query.orders.findFirst({
        where: this.orderIdFilter(shopId, id),
      });
      if (!order) {
        throw new NotFoundException('Order not found');
      }
      if (order.pay === 'Refunded') {
        throw new ConflictException('Order is already refunded');
      }
      const [row] = await tx
        .update(orders)
        .set({ pay: 'Refunded' })
        .where(eq(orders.id, order.id))
        .returning();
      if (order.customerId) {
        await this.customers.applyRefund(
          tx,
          order.customerId,
          order.totalCents,
        );
      }
      const items = await tx.query.orderItems.findMany({
        where: eq(orderItems.orderId, order.id),
      });
      return OrderResponse.fromRow(row, items);
    });
  }

  private async requireOwned(shopId: string, id: string): Promise<OrderRow> {
    const order = await this.db.query.orders.findFirst({
      where: this.orderIdFilter(shopId, id),
    });
    if (!order) {
      throw new NotFoundException('Order not found');
    }
    return order;
  }

  /** Allocates the next "#NNNN" reference for a shop (starts at #1001). */
  private async nextReference(
    tx: Parameters<Parameters<DrizzleDB['transaction']>[0]>[0],
    shopId: string,
  ): Promise<string> {
    const [{ value }] = await tx
      .select({ value: count() })
      .from(orders)
      .where(eq(orders.shopId, shopId));
    return `#${1001 + value}`;
  }
}
