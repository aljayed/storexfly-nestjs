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
  combos,
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
  New: 'Confirmed',
  Confirmed: 'Packed',
  Packed: 'Shipped',
  Shipped: 'Delivered',
  Delivered: null,
  Cancelled: null,
};

/** Statuses from which an order may still be cancelled (before it's packed). */
const CANCELLABLE: readonly OrderStatus[] = ['New', 'Confirmed'];

/** The transaction handle used inside `checkout`. */
type OrdersTx = Parameters<Parameters<DrizzleDB['transaction']>[0]>[0];

/** Priced line items + stock deductions computed for one checkout. */
interface CheckoutCart {
  /** Order total in cents (line totals always sum to this). */
  totalCents: number;
  /** Physical units leaving stock — shown as the order's qty. */
  totalUnits: number;
  /** Per-product stock decrements to apply. */
  deductions: { productId: string; units: number }[];
  lines: {
    productId: string | null;
    name: string;
    qty: number;
    unitPriceCents: number;
    variant: string | null;
  }[];
}

@Injectable()
export class OrdersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly customers: CustomersService,
    private readonly paymentMethods: PaymentMethodsService,
  ) {}

  /**
   * Inline product-page checkout — a single product (with optional variant
   * selection and multi-buy pack) or a combo offer. Runs in a transaction:
   * validates stock, computes totals server-side, allocates a per-shop
   * reference, decrements stock, rolls the customer aggregates forward, and
   * persists the order + line items atomically.
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
    if (!dto.productId === !dto.comboId) {
      throw new BadRequestException(
        'Provide either a product or a combo to order.',
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

      // Build the priced line items + stock deductions for either flow.
      const cart = dto.comboId
        ? await this.buildComboCart(tx, dto, method.kind)
        : await this.buildProductCart(tx, dto, method.kind);

      const placedAt = new Date();
      const reference = await this.nextReference(tx, dto.shopId);

      for (const d of cart.deductions) {
        await tx
          .update(products)
          .set({ stock: sql`${products.stock} - ${d.units}` })
          .where(eq(products.id, d.productId));
      }

      const customerId = await this.customers.recordOrder(tx, {
        shopId: dto.shopId,
        name: dto.contact.name,
        email: dto.contact.email ?? `${dto.contact.phone}@phone.local`,
        phone: dto.contact.phone,
        city: dto.address.area,
        amountCents: cart.totalCents,
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
          qty: cart.totalUnits,
          totalCents: cart.totalCents,
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

      await tx.insert(orderItems).values(
        cart.lines.map((line) => ({
          orderId: order.id,
          productId: line.productId,
          name: line.name,
          qty: line.qty,
          unitPriceCents: line.unitPriceCents,
          variant: line.variant,
        })),
      );

      return {
        orderId: order.reference,
        total: cart.totalCents / 100,
        paymentMethod: dto.paymentMethod,
        qty: dto.qty,
        eta: 'Tomorrow, by 7 PM',
      };
    });
  }

  /**
   * Single-product checkout: resolves the variant selection (one option per
   * group the product defines) and an optional multi-buy pack into a priced
   * line. Deltas apply per unit, so a pack of N carries N × delta on top of
   * the pack price.
   */
  private async buildProductCart(
    tx: OrdersTx,
    dto: CheckoutDto,
    payKind: string,
  ): Promise<CheckoutCart> {
    const product = await tx.query.products.findFirst({
      where: and(
        eq(products.id, dto.productId!),
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
    // Sellers toggle payment *kinds* per product (COD / mobile banking /
    // card); the picked method must belong to an allowed kind.
    if (!product.paymentMethods.includes(payKind as never)) {
      throw new BadRequestException(
        'This item cannot be paid with that method — please pick another.',
      );
    }

    // One option per variant group is mandatory once a product defines groups.
    const parts: string[] = [];
    let deltaCents = 0;
    for (const group of product.variantGroups ?? []) {
      const option = group.options.find(
        (o) => o.id === dto.variant?.[group.id],
      );
      if (!option) {
        throw new BadRequestException(
          `Please choose an option for “${group.name}”`,
        );
      }
      deltaCents += option.priceDeltaCents;
      parts.push(`${group.name}: ${option.label}`);
    }

    // A pack re-prices the line: qty counts packs, each consuming pack.units.
    let unitsPerPick = 1;
    let unitPriceCents = Math.max(0, product.priceCents + deltaCents);
    if (dto.packId) {
      const pack = (product.packs ?? []).find((p) => p.id === dto.packId);
      if (!pack) {
        throw new BadRequestException(
          'That pack is no longer available — please reload and pick again.',
        );
      }
      unitsPerPick = pack.units;
      unitPriceCents = Math.max(0, pack.priceCents + pack.units * deltaCents);
      parts.push(pack.label.trim() || `Pack of ${pack.units}`);
    }

    const totalUnits = unitsPerPick * dto.qty;
    if (product.stock < totalUnits) {
      throw new ConflictException('Not enough stock for this quantity');
    }

    return {
      totalCents: unitPriceCents * dto.qty,
      totalUnits,
      deductions: [{ productId: product.id, units: totalUnits }],
      lines: [
        {
          productId: product.id,
          name: product.name,
          qty: dto.qty,
          unitPriceCents,
          variant: parts.length ? parts.join(' · ').slice(0, 240) : null,
        },
      ],
    };
  }

  /**
   * Combo checkout: every member is validated + decremented individually and
   * written as a full-price line (so cancel-restock and reporting keep
   * working), with one final negative "combo discount" line bringing the sum
   * down to the combo price.
   */
  private async buildComboCart(
    tx: OrdersTx,
    dto: CheckoutDto,
    payKind: string,
  ): Promise<CheckoutCart> {
    const combo = await tx.query.combos.findFirst({
      where: and(eq(combos.id, dto.comboId!), eq(combos.shopId, dto.shopId)),
      with: { items: { with: { product: true } } },
    });
    if (!combo || !combo.active || combo.items.length < 2) {
      throw new NotFoundException('This combo offer is no longer available.');
    }

    let membersValueCents = 0;
    let totalUnits = 0;
    const deductions: CheckoutCart['deductions'] = [];
    const lines: CheckoutCart['lines'] = [];
    for (const item of combo.items) {
      const product = item.product;
      if (product.listingType !== 'sale') {
        throw new ConflictException('This combo offer is no longer available.');
      }
      // A member that disallows the picked payment kind restricts the combo.
      if (!product.paymentMethods.includes(payKind as never)) {
        throw new BadRequestException(
          'This combo cannot be paid with that method — please pick another.',
        );
      }
      const units = item.qty * dto.qty;
      if (product.stock < units) {
        throw new ConflictException(
          `Not enough stock of ${product.name} for this quantity`,
        );
      }
      membersValueCents += product.priceCents * units;
      totalUnits += units;
      deductions.push({ productId: product.id, units });
      lines.push({
        productId: product.id,
        name: product.name,
        qty: units,
        unitPriceCents: product.priceCents,
        variant: `Combo: ${combo.name}`.slice(0, 240),
      });
    }

    // One adjustment line reconciles the full-price member lines with the
    // combo price, so line totals always sum to the order total.
    const totalCents = combo.priceCents * dto.qty;
    const adjustCents = totalCents - membersValueCents;
    if (adjustCents !== 0) {
      lines.push({
        productId: null,
        name: `Combo ${adjustCents < 0 ? 'discount' : 'adjustment'} — ${combo.name}`.slice(
          0,
          200,
        ),
        qty: 1,
        unitPriceCents: adjustCents,
        variant: null,
      });
    }

    return { totalCents, totalUnits, deductions, lines };
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
          revenueCents: sql<string>`coalesce(sum(${orders.totalCents}) filter (where ${orders.pay} = 'Paid' and ${orders.status} <> 'Cancelled'), 0)`,
          paidCount: sql<string>`count(*) filter (where ${orders.pay} = 'Paid' and ${orders.status} <> 'Cancelled')`,
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

  /**
   * Cancel an unconfirmed/confirmed order the customer never went through with.
   * Only allowed before packing. Restocks every line item, marks the order
   * 'Cancelled', and unwinds the order from the customer's lifetime aggregates.
   */
  async cancel(shopId: string, id: string): Promise<OrderResponse> {
    return this.db.transaction(async (tx) => {
      const order = await tx.query.orders.findFirst({
        where: this.orderIdFilter(shopId, id),
      });
      if (!order) {
        throw new NotFoundException('Order not found');
      }
      if (!CANCELLABLE.includes(order.status)) {
        throw new BadRequestException(
          "Only orders that haven't been packed can be cancelled",
        );
      }

      const items = await tx.query.orderItems.findMany({
        where: eq(orderItems.orderId, order.id),
      });
      // Put the reserved stock back for every line that still points at a
      // live product (productId is null once a product has been deleted).
      for (const item of items) {
        if (!item.productId) continue;
        await tx
          .update(products)
          .set({ stock: sql`${products.stock} + ${item.qty}` })
          .where(eq(products.id, item.productId));
      }

      const [row] = await tx
        .update(orders)
        .set({ status: 'Cancelled' })
        .where(eq(orders.id, order.id))
        .returning();

      if (order.customerId) {
        await this.customers.unwindOrder(
          tx,
          order.customerId,
          order.totalCents,
        );
      }
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
