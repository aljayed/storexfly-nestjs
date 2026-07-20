import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import { centsToDollars } from '../../common/utils/money.util';
import {
  FREE_SALES_CAP_CENTS,
  FREE_TIER_LIMIT_MESSAGE,
} from '../../common/constants/billing';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import {
  combos,
  gatewayPayments,
  orderItems,
  orders,
  products,
  shops,
  type OrderRow,
} from '../../database/schema';
import type { OrderStatus, SalesChannel } from '../../database/schema/enums';
import { CustomersService } from '../customers/customers.service';
import { BkashService } from '../gateways/bkash.service';
import { PathaoService } from '../gateways/pathao.service';
import { ShopCourierSettingsService } from '../gateways/shop-courier-settings.service';
import { SteadfastService } from '../gateways/steadfast.service';
import { NotificationsService } from '../notifications/notifications.service';
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

/** Statuses a buyer may self-cancel from — only before the seller confirms. */
const BUYER_CANCELLABLE: readonly OrderStatus[] = ['New'];

/** Statuses from which the seller may hand the parcel to the courier. */
const COURIER_BOOKABLE: readonly OrderStatus[] = ['Confirmed', 'Packed'];

/** Buyer-facing copy for status-change notifications. */
const STATUS_NOTIFICATION: Partial<Record<OrderStatus, string>> = {
  Confirmed: 'has been confirmed by the seller',
  Packed: 'has been packed and is getting ready to ship',
  Shipped: 'is on its way',
  Delivered: 'has been delivered — enjoy!',
};

/** The transaction handle used inside `checkout`. */
type OrdersTx = Parameters<Parameters<DrizzleDB['transaction']>[0]>[0];

/** Priced line items + stock deductions computed for one checkout. */
interface CheckoutCart {
  /** Order total in cents including delivery (lines always sum to this). */
  totalCents: number;
  /** Delivery charge included in the total (0 = free delivery). */
  deliveryCents: number;
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
    private readonly notifications: NotificationsService,
    private readonly bkash: BkashService,
    private readonly steadfast: SteadfastService,
    private readonly pathao: PathaoService,
    private readonly courierSettings: ShopCourierSettingsService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Inline product-page checkout — a single product (with optional variant
   * selection and multi-buy pack) or a combo offer. Runs in a transaction
   * that locks the shop row, serializing checkouts per shop so reference
   * allocation and stock arithmetic cannot race; stock updates are still
   * guarded (`stock >= n`) as defense in depth.
   *
   * Payment truth: COD and direct-transfer methods create the order as
   * 'Due' (money not yet verified in hand); a gateway method creates it as
   * 'Pending' and returns a `paymentUrl` to the bKash hosted checkout — the
   * order only becomes 'Paid' when bKash confirms the money.
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
    if (method.gateway === 'bkash' && !(await this.bkash.isConfigured())) {
      throw new BadRequestException(
        'bKash payments are temporarily unavailable — please pick another method.',
      );
    }
    if (!dto.productId === !dto.comboId) {
      throw new BadRequestException(
        'Provide either a product or a combo to order.',
      );
    }

    const payStatus = method.gateway !== 'none' ? 'Pending' : 'Due';

    const order = await this.db.transaction(async (tx) => {
      // Lock the shop row: all concurrent checkouts for this shop queue here,
      // which makes the "#NNNN" reference and stock math race-free.
      const [shop] = await tx
        .select({ live: shops.live, plan: shops.plan })
        .from(shops)
        .where(eq(shops.id, dto.shopId))
        .for('update');
      // A switched-off shop is closed to buyers — no orders either.
      if (!shop?.live) {
        throw new ForbiddenException('This shop is currently offline.');
      }

      // Free tier: a shop may sell up to ৳5,000 lifetime; the order that
      // crosses the cap still goes through, then the shop is deactivated
      // until the seller subscribes.
      let priorSalesCents = 0;
      if (shop.plan === 'free') {
        priorSalesCents = await this.lifetimeSalesCents(tx, dto.shopId);
        if (priorSalesCents >= FREE_SALES_CAP_CENTS) {
          throw new ForbiddenException(FREE_TIER_LIMIT_MESSAGE);
        }
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

      // Guarded decrement: even though the shop lock serializes checkouts,
      // never let stock go negative if anything else touches it.
      for (const d of cart.deductions) {
        const updated = await tx
          .update(products)
          .set({ stock: sql`${products.stock} - ${d.units}` })
          .where(
            and(eq(products.id, d.productId), gte(products.stock, d.units)),
          )
          .returning({ id: products.id });
        if (!updated.length) {
          throw new ConflictException('Not enough stock for this quantity');
        }
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
          deliveryCents: cart.deliveryCents,
          status: 'New',
          pay: payStatus,
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

      // Crossing the free-tier cap deactivates the shop (this order stands).
      if (
        shop.plan === 'free' &&
        priorSalesCents + cart.totalCents >= FREE_SALES_CAP_CENTS
      ) {
        await tx
          .update(shops)
          .set({ live: false })
          .where(eq(shops.id, dto.shopId));
      }

      // Gateway orders notify once the payment is confirmed instead.
      if (payStatus !== 'Pending') {
        await this.notifications.orderEvent(
          tx,
          order,
          'order_placed',
          `Order ${order.reference} placed`,
          `Your order has been placed. ${
            method.kind === 'cod'
              ? 'Pay in cash when it arrives.'
              : 'The seller will confirm your payment shortly.'
          }`,
        );
      }
      return order;
    });

    // Hosted-gateway leg runs after the commit (never hold a DB transaction
    // across an external HTTP call). If bKash cannot open a payment the
    // pending order is voided again — stock and customer stats roll back.
    if (method.gateway === 'bkash') {
      try {
        const created = await this.bkash.createPayment({
          amountCents: order.totalCents,
          invoiceNumber: `${order.reference.replace('#', '')}-${order.id.slice(0, 8)}`,
          payerReference: dto.contact.phone.replace(/\D/g, ''),
          callbackUrl: this.bkashCallbackUrl(),
        });
        await this.db.insert(gatewayPayments).values({
          orderId: order.id,
          provider: 'bkash',
          paymentId: created.paymentId,
          amountCents: order.totalCents,
          payerReference: dto.contact.phone.replace(/\D/g, '').slice(0, 40),
        });
        return this.checkoutResult(order, dto, {
          paymentUrl: created.bkashUrl,
        });
      } catch (err) {
        await this.voidPendingOrder(order.id);
        throw err;
      }
    }

    return this.checkoutResult(order, dto, {});
  }

  private checkoutResult(
    order: OrderRow,
    dto: CheckoutDto,
    extra: { paymentUrl?: string },
  ): CheckoutResultResponse {
    return {
      orderId: order.reference,
      total: order.totalCents / 100,
      delivery: order.deliveryCents / 100,
      paymentMethod: dto.paymentMethod,
      qty: dto.qty,
      eta: 'Within 2–3 days',
      payStatus: order.pay,
      ...extra,
    };
  }

  private bkashCallbackUrl(): string {
    const apiUrl =
      this.config.get<string>('app.apiUrl') ?? 'http://localhost:3000';
    const prefix = this.config.get<string>('app.apiPrefix') ?? 'api';
    return `${apiUrl.replace(/\/$/, '')}/${prefix}/payments/bkash/callback`;
  }

  /** Lifetime sales (everything not cancelled) — the free-tier cap metric. */
  private async lifetimeSalesCents(
    executor: OrdersTx | DrizzleDB,
    shopId: string,
  ): Promise<number> {
    const [{ cents }] = await executor
      .select({
        cents: sql<string>`coalesce(sum(${orders.totalCents}) filter (where ${orders.status} <> 'Cancelled'), 0)`,
      })
      .from(orders)
      .where(eq(orders.shopId, shopId));
    return Number(cents);
  }

  /**
   * Single-product checkout: resolves the variant selection (one option per
   * group the product defines) and an optional multi-buy pack into a priced
   * line, then adds the product's zone delivery charge. Deltas apply per
   * unit, so a pack of N carries N × delta on top of the pack price.
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

    const lines: CheckoutCart['lines'] = [
      {
        productId: product.id,
        name: product.name,
        qty: dto.qty,
        unitPriceCents,
        variant: parts.length ? parts.join(' · ').slice(0, 240) : null,
      },
    ];
    const deliveryCents = this.deliveryFeeCents(dto, [product]);
    this.pushDeliveryLine(lines, deliveryCents, dto);

    return {
      totalCents: unitPriceCents * dto.qty + deliveryCents,
      deliveryCents,
      totalUnits,
      deductions: [{ productId: product.id, units: totalUnits }],
      lines,
    };
  }

  /**
   * Combo checkout: every member is validated + decremented individually and
   * written as a full-price line (so cancel-restock and reporting keep
   * working), with one final negative "combo discount" line bringing the sum
   * down to the combo price, plus the delivery charge (one shipment — the
   * highest member fee for the buyer's zone).
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
    const comboCents = combo.priceCents * dto.qty;
    const adjustCents = comboCents - membersValueCents;
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

    const deliveryCents = this.deliveryFeeCents(
      dto,
      combo.items.map((i) => i.product),
    );
    this.pushDeliveryLine(lines, deliveryCents, dto);

    return {
      totalCents: comboCents + deliveryCents,
      deliveryCents,
      totalUnits,
      deductions,
      lines,
    };
  }

  /**
   * The zone delivery charge the storefront quoted: the product's Dhaka /
   * outside-Dhaka fee (a combo ships together — its highest member fee).
   * The buyer's chosen district decides the zone, same rule as the UI.
   */
  private deliveryFeeCents(
    dto: CheckoutDto,
    items: { deliveryDhakaCents: number; deliveryOutsideCents: number }[],
  ): number {
    const inDhaka = dto.address.area.trim().toLowerCase() === 'dhaka';
    return Math.max(
      0,
      ...items.map((p) =>
        inDhaka ? p.deliveryDhakaCents : p.deliveryOutsideCents,
      ),
    );
  }

  private pushDeliveryLine(
    lines: CheckoutCart['lines'],
    deliveryCents: number,
    dto: CheckoutDto,
  ): void {
    if (deliveryCents <= 0) return;
    const inDhaka = dto.address.area.trim().toLowerCase() === 'dhaka';
    lines.push({
      productId: null,
      name: 'Delivery charge',
      qty: 1,
      unitPriceCents: deliveryCents,
      variant: inDhaka ? 'Inside Dhaka' : 'Outside Dhaka',
    });
  }

  /**
   * Paginated admin list. `total` counts the filtered set; `stats` are
   * shop-wide aggregates (one grouped query) so tab counts and KPI cards
   * stay correct regardless of the active page or filter. Orders whose
   * gateway payment is still in flight (pay = 'Pending') are hidden — they
   * only enter the pipeline once bKash confirms the money.
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
    const visible = and(eq(orders.shopId, shopId), ne(orders.pay, 'Pending'))!;
    const conditions = [visible];
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
        .where(visible)
        .groupBy(orders.status),
      this.db
        .select({
          revenueCents: sql<string>`coalesce(sum(${orders.totalCents}) filter (where ${orders.pay} = 'Paid' and ${orders.status} <> 'Cancelled'), 0)`,
          paidCount: sql<string>`count(*) filter (where ${orders.pay} = 'Paid' and ${orders.status} <> 'Cancelled')`,
          refunded: sql<string>`count(*) filter (where ${orders.pay} = 'Refunded')`,
        })
        .from(orders)
        .where(visible),
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

  /**
   * Advance the pipeline New→Confirmed→Packed→Shipped→Delivered (one step at
   * a time). Delivering a COD order also collects its cash: pay flips to
   * 'Paid' at the doorstep.
   */
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
    const codCollected =
      next === 'Delivered' &&
      order.pay === 'Due' &&
      (await this.isCodOrder(order));
    const [row] = await this.db
      .update(orders)
      .set({ status: next, ...(codCollected && { pay: 'Paid' as const }) })
      .where(eq(orders.id, order.id))
      .returning();
    const copy = STATUS_NOTIFICATION[next];
    if (copy) {
      await this.notifications.orderEvent(
        this.db,
        row,
        'order_status',
        `Order ${row.reference} ${next.toLowerCase()}`,
        `Your order ${copy}.`,
      );
    }
    const items = await this.db.query.orderItems.findMany({
      where: eq(orderItems.orderId, order.id),
    });
    return OrderResponse.fromRow(row, items);
  }

  /**
   * Seller confirms a direct transfer (bKash/Nagad "send money" to their own
   * number) actually arrived. Gateway-collected methods confirm themselves,
   * so they are excluded — a seller cannot self-mark platform money as paid.
   */
  async markPaid(shopId: string, id: string): Promise<OrderResponse> {
    const order = await this.requireOwned(shopId, id);
    if (order.pay !== 'Due') {
      throw new ConflictException(
        'Only unpaid (due) orders can be marked paid.',
      );
    }
    if (order.status === 'Cancelled') {
      throw new ConflictException('This order was cancelled.');
    }
    const method = order.paymentMethod
      ? (await this.paymentMethods.byCode()).get(order.paymentMethod)
      : undefined;
    if (method && method.gateway !== 'none') {
      throw new ConflictException(
        'This order is collected by the payment gateway and confirms automatically.',
      );
    }
    const [row] = await this.db
      .update(orders)
      .set({ pay: 'Paid' })
      .where(eq(orders.id, order.id))
      .returning();
    await this.notifications.orderEvent(
      this.db,
      row,
      'payment_confirmed',
      `Payment received for order ${row.reference}`,
      'The seller confirmed your payment. Thank you!',
    );
    const items = await this.db.query.orderItems.findMany({
      where: eq(orderItems.orderId, order.id),
    });
    return OrderResponse.fromRow(row, items);
  }

  /**
   * Refund a paid order and unwind its contribution to the customer's spend.
   * Cancelled orders were already unwound by `cancel` and cannot also be
   * refunded (that would subtract the money twice).
   */
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
      if (order.pay !== 'Paid') {
        throw new ConflictException('Only paid orders can be refunded');
      }
      if (order.status === 'Cancelled') {
        throw new ConflictException('Cancelled orders cannot be refunded');
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
      await this.notifications.orderEvent(
        tx,
        row,
        'order_refunded',
        `Order ${row.reference} refunded`,
        'Your payment for this order has been refunded.',
      );
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
      // A refunded order was already unwound from the customer's spend —
      // cancelling it too would subtract the money a second time.
      if (order.pay === 'Refunded') {
        throw new ConflictException(
          'This order was refunded; it can no longer be cancelled.',
        );
      }
      const row = await this.cancelTx(tx, order);
      await this.notifications.orderEvent(
        tx,
        row,
        'order_cancelled',
        `Order ${row.reference} cancelled`,
        'This order has been cancelled. Any stock has been released.',
      );
      const items = await tx.query.orderItems.findMany({
        where: eq(orderItems.orderId, order.id),
      });
      return OrderResponse.fromRow(row, items);
    });
  }

  /**
   * Buyer self-service cancel — only while the order is still 'New' (the shop
   * admin hasn't confirmed it). Ownership is the order-email ↔ account match,
   * the same link the buyer's order list is built on. Paid orders are excluded:
   * cancelling one implies a refund, which stays a shop-side action.
   */
  async cancelByBuyer(
    buyerEmail: string,
    shopId: string,
    reference: string,
  ): Promise<OrderResponse> {
    return this.db.transaction(async (tx) => {
      const order = await tx.query.orders.findFirst({
        where: and(eq(orders.shopId, shopId), eq(orders.reference, reference)),
      });
      // A foreign order is reported identically to a missing one, so the
      // endpoint can't be used to probe other buyers' references.
      if (!order || order.email !== buyerEmail) {
        throw new NotFoundException('Order not found');
      }
      if (order.status === 'Cancelled') {
        throw new ConflictException('This order is already cancelled.');
      }
      if (!BUYER_CANCELLABLE.includes(order.status) || order.pay === 'Paid') {
        throw new BadRequestException(
          'The shop has already started processing this order — please contact the shop to cancel it.',
        );
      }
      const row = await this.cancelTx(tx, order);
      await this.notifications.orderEvent(
        tx,
        row,
        'order_cancelled',
        `Order ${row.reference} cancelled`,
        'You cancelled this order. Any reserved stock has been released.',
      );
      const items = await tx.query.orderItems.findMany({
        where: eq(orderItems.orderId, order.id),
      });
      return OrderResponse.fromRow(row, items);
    });
  }

  /** Shared cancel core: restock, mark 'Cancelled', unwind customer stats. */
  private async cancelTx(tx: OrdersTx, order: OrderRow): Promise<OrderRow> {
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
      await this.customers.unwindOrder(tx, order.customerId, order.totalCents);
    }
    return row;
  }

  /**
   * Void an order whose gateway payment never completed (bKash create
   * failed, the buyer cancelled on the hosted page, or the attempt expired).
   * Idempotent: only acts while the order is still pending.
   */
  async voidPendingOrder(orderId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const order = await tx.query.orders.findFirst({
        where: eq(orders.id, orderId),
      });
      if (!order || order.pay !== 'Pending' || order.status === 'Cancelled') {
        return;
      }
      await this.cancelTx(tx, order);
    });
  }

  /** Called by the payments flow when the gateway confirms the money. */
  async confirmGatewayPayment(orderId: string): Promise<OrderRow | null> {
    const [row] = await this.db
      .update(orders)
      .set({ pay: 'Paid' })
      .where(and(eq(orders.id, orderId), eq(orders.pay, 'Pending')))
      .returning();
    if (row) {
      await this.notifications.orderEvent(
        this.db,
        row,
        'payment_confirmed',
        `Order ${row.reference} confirmed`,
        'Your bKash payment was received and your order is now with the seller.',
      );
    }
    return row ?? null;
  }

  // ── Courier (Steadfast / Pathao, per-shop) ─────────────────────

  /**
   * Book a parcel for a confirmed/packed order through the courier the shop
   * has enabled (none enabled = the seller delivers manually). The courier
   * collects the order total in cash when the money is still due (COD),
   * nothing when it was prepaid. Pathao additionally needs the recipient's
   * city/zone as Pathao IDs, picked by the seller in the booking modal.
   */
  async bookCourier(
    shopId: string,
    id: string,
    opts?: { cityId?: number; zoneId?: number; areaId?: number },
  ): Promise<OrderResponse> {
    const order = await this.requireOwned(shopId, id);
    if (order.courierConsignmentId) {
      throw new ConflictException(
        'A courier is already booked for this order.',
      );
    }
    if (!COURIER_BOOKABLE.includes(order.status)) {
      throw new BadRequestException(
        'Book the courier once the order is confirmed or packed.',
      );
    }
    if (!order.phone) {
      throw new BadRequestException('This order has no delivery phone number.');
    }
    const address = [
      order.address?.line,
      order.address?.area,
      order.address?.pincode,
    ]
      .filter(Boolean)
      .join(', ');
    if (!address) {
      throw new BadRequestException('This order has no delivery address.');
    }
    const active = await this.courierSettings.activeCourier(shopId);
    if (!active) {
      throw new BadRequestException(
        'No courier is enabled for this shop — enable Steadfast or Pathao in Settings, or deliver manually.',
      );
    }
    const shipment = {
      invoice: `${order.reference.replace('#', '')}-${order.id.slice(0, 8)}`,
      recipientName: order.customerName,
      recipientPhone: order.phone,
      recipientAddress: address,
      codAmountCents: order.pay === 'Due' ? order.totalCents : 0,
      note: `Order ${order.reference}`,
    };
    let booked: {
      consignmentId: string;
      trackingCode: string | null;
      status: string;
    };
    if (active.provider === 'steadfast') {
      const c = await this.steadfast.createConsignment(active.config, shipment);
      booked = {
        consignmentId: c.consignmentId,
        trackingCode: c.trackingCode,
        status: c.status,
      };
    } else {
      if (!opts?.cityId || !opts.zoneId) {
        throw new BadRequestException(
          'Pick the delivery city and zone to book with Pathao.',
        );
      }
      const c = await this.pathao.createOrder(active.config, {
        ...shipment,
        cityId: opts.cityId,
        zoneId: opts.zoneId,
        areaId: opts.areaId,
        itemQuantity: order.qty,
      });
      // Pathao has no separate tracking code — the consignment ID is it.
      booked = {
        consignmentId: c.consignmentId,
        trackingCode: c.consignmentId,
        status: c.status,
      };
    }
    const [row] = await this.db
      .update(orders)
      .set({
        courierProvider: active.provider,
        courierConsignmentId: booked.consignmentId,
        courierTrackingCode: booked.trackingCode,
        courierStatus: booked.status,
      })
      .where(eq(orders.id, order.id))
      .returning();
    const items = await this.db.query.orderItems.findMany({
      where: eq(orderItems.orderId, order.id),
    });
    return OrderResponse.fromRow(row, items);
  }

  /**
   * Refresh the consignment's delivery status from its provider. A delivered
   * parcel completes the order (and collects COD cash); everything else just
   * updates the badge the seller sees.
   */
  async refreshCourier(shopId: string, id: string): Promise<OrderResponse> {
    const order = await this.requireOwned(shopId, id);
    if (!order.courierConsignmentId) {
      throw new NotFoundException('No courier is booked for this order.');
    }
    const status = await this.courierStatus(shopId, order);
    let row = order;
    if (status && status !== order.courierStatus) {
      const delivered =
        status === 'delivered' &&
        order.status !== 'Delivered' &&
        order.status !== 'Cancelled';
      const codCollected =
        delivered && order.pay === 'Due' && (await this.isCodOrder(order));
      [row] = await this.db
        .update(orders)
        .set({
          courierStatus: status,
          ...(delivered && { status: 'Delivered' as const }),
          ...(codCollected && { pay: 'Paid' as const }),
        })
        .where(eq(orders.id, order.id))
        .returning();
      if (delivered) {
        await this.notifications.orderEvent(
          this.db,
          row,
          'order_status',
          `Order ${row.reference} delivered`,
          'Your order has been delivered — enjoy!',
        );
      }
    }
    const items = await this.db.query.orderItems.findMany({
      where: eq(orderItems.orderId, order.id),
    });
    return OrderResponse.fromRow(row, items);
  }

  /** Ask the provider that booked this consignment for its current status.
   *  Legacy rows booked before per-shop couriers were all Steadfast. */
  private async courierStatus(
    shopId: string,
    order: OrderRow,
  ): Promise<string | null> {
    if (order.courierProvider === 'pathao') {
      const config = await this.courierSettings.pathaoConfig(shopId);
      if (!config) {
        throw new BadRequestException(
          'Pathao credentials were removed — add them back in Settings to track this parcel.',
        );
      }
      return this.pathao.status(config, order.courierConsignmentId!);
    }
    const config = await this.courierSettings.steadfastConfig(shopId);
    if (!config) {
      throw new BadRequestException(
        'Steadfast credentials are missing — add them in Settings to track this parcel.',
      );
    }
    return this.steadfast.status(config, order.courierConsignmentId!);
  }

  private async isCodOrder(order: OrderRow): Promise<boolean> {
    if (!order.paymentMethod) return false;
    const method = (await this.paymentMethods.byCode()).get(
      order.paymentMethod,
    );
    return method?.kind === 'cod';
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

  /**
   * Allocates the next "#NNNN" reference for a shop (starts at #1001).
   * Safe because `checkout` holds the shop row lock while calling this.
   */
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
