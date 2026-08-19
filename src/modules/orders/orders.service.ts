import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
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
  inArray,
  isNull,
  lt,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import { centsToDollars, dollarsToCents } from '../../common/utils/money.util';
import {
  DELIVERY_LINE_NAME,
  orderLineKind,
  productLines,
} from '../../common/utils/order-line.util';
import {
  CREDIT_EXHAUSTED_MESSAGE,
  FREE_ORDER_CAP,
  FREE_TIER_LIMIT_MESSAGE,
} from '../../common/constants/billing';
import { creditPosition } from '../subscriptions/credit-balance';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import {
  combos,
  courierWebhookEvents,
  subscriptions,
  orderAmountAdjustments,
  orderItems,
  orders,
  products,
  shops,
  users,
  type CourierWebhookEventRow,
  type OrderRow,
  type ProductRow,
} from '../../database/schema';
import type { OrderStatus, SalesChannel } from '../../database/schema/enums';
import { CustomersService } from '../customers/customers.service';
import type { CheckoutCaller } from '../risk/checkout-caller';
import { PhoneProofService } from '../risk/phone-proof.service';
import { EmailProofService } from '../risk/email-proof.service';
import {
  RISK_WINDOW_HOURS,
  RiskService,
  type CheckoutRisk,
} from '../risk/risk.service';
import {
  GatewayCheckoutService,
  type CollectingGateway,
} from '../gateways/gateway-checkout.service';
import { CarrybeeService } from '../gateways/carrybee.service';
import {
  CARRYBEE_EVENTS,
  CARRYBEE_STATUS_EFFECTS,
  type CarrybeeWebhookBody,
  type CourierEffect,
} from '../gateways/carrybee-events';
import { CourierSettingsService } from '../gateways/courier-settings.service';
import { ShopCourierStoresService } from '../gateways/shop-courier-stores.service';
import { PathaoService } from '../gateways/pathao.service';
import { SteadfastService } from '../gateways/steadfast.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MessagesService } from '../chat/messages.service';
import { PaymentMethodsService } from '../settlements/payment-methods.service';
import {
  ShopCouponsService,
  normalizeCouponPhone,
  type CouponBasis,
} from '../shop-coupons/shop-coupons.service';
import type { CouponQuoteResponse } from '../shop-coupons/dto/shop-coupon.response';
import type { PaymentMethodRow, ShopCouponRow } from '../../database/schema';
import type { CheckoutDto, CouponQuoteDto } from './dto/checkout.dto';
import { BuyerOrderDetailResponse } from './dto/buyer-order-detail.response';
import { CheckoutResultResponse } from './dto/checkout-result.response';
import { OrderListResponse } from './dto/order-list.response';
import { OrderResponse } from './dto/order.response';

/**
 * Allowed forward transitions for the order pipeline.
 *
 * 'HandedOver' is where the shop's authority ends. Everything up to it is the
 * seller's to drive by hand; past it only the courier can move the order (see
 * SELLER_ADVANCEABLE and `applyCourierEffect`), because a shop that can mark
 * its own orders shipped, delivered or cancelled can steer them around the
 * sales meter it is billed on.
 */
const STATUS_FLOW: Record<OrderStatus, OrderStatus | null> = {
  New: 'Confirmed',
  Confirmed: 'Packed',
  Packed: 'HandedOver',
  HandedOver: 'Shipped',
  Shipped: 'Delivered',
  Delivered: null,
  Cancelled: null,
};

/**
 * The steps a seller may take by hand. 'Shipped' and 'Delivered' are missing
 * on purpose - those arrive from the courier's webhook, or from a status
 * refresh against the courier's API, and from nowhere else.
 */
const SELLER_ADVANCEABLE: readonly OrderStatus[] = [
  'New',
  'Confirmed',
  'Packed',
];

/** Statuses from which an order may still be cancelled (before it's packed). */
const CANCELLABLE: readonly OrderStatus[] = ['New', 'Confirmed'];

/** Statuses a buyer may self-cancel from - only before the seller confirms. */
const BUYER_CANCELLABLE: readonly OrderStatus[] = ['New'];

/** Statuses from which the seller may book the parcel with the courier. */
const COURIER_BOOKABLE: readonly OrderStatus[] = ['Confirmed', 'Packed'];

/**
 * Statuses at which the seller may still propose an amount change: before the
 * parcel leaves their hands. Past handover the total is locked (a courier COD
 * amount is fixed at booking and money has effectively started moving).
 */
const AMOUNT_ADJUSTABLE: readonly OrderStatus[] = [
  'New',
  'Confirmed',
  'Packed',
];

/**
 * How often unprocessed courier callbacks are retried, and how many times
 * before one is left for a human. Five minutes is well inside the window that
 * matters - a parcel's next event is minutes to hours away - and eight
 * attempts spans over half an hour of whatever was briefly broken.
 */
const WEBHOOK_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const MAX_WEBHOOK_ATTEMPTS = 8;
/** Cap per sweep so a backlog can't monopolise a tick. */
const WEBHOOK_SWEEP_BATCH = 200;

/** Buyer-facing copy for status-change notifications. */
const STATUS_NOTIFICATION: Partial<Record<OrderStatus, string>> = {
  Confirmed: 'has been confirmed by the seller',
  Packed: 'has been packed and is getting ready to ship',
  HandedOver: 'has been handed to the courier',
  Shipped: 'is on its way',
  Delivered: 'has been delivered - enjoy!',
};

/** The transaction handle used inside `checkout`. */
type OrdersTx = Parameters<Parameters<DrizzleDB['transaction']>[0]>[0];

/** "৳1,500" from integer cents - buyer-facing money in notification copy. */
function formatBdt(cents: number): string {
  return `৳${centsToDollars(cents).toLocaleString('en-US')}`;
}

/** Reduce any BD phone format to the bare national number (same rule as the
 *  notifications matcher), so an order's phone can be matched to a buyer row. */
function normalizePhone(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\D/g, '').replace(/^880/, '').replace(/^0+/, '');
}

/**
 * How far back "already ordered this" looks. Deliberately the same window the
 * risk gates use, so a buyer meets one consistent idea of "recently" across
 * checkout rather than two that expire at different moments.
 *
 * A rolling window rather than a calendar day on purpose: a day boundary makes
 * the rule arbitrary either side of midnight - an order at 11pm blocks nothing
 * an hour later, while one at 1am blocks all day.
 */
export function repeatItemWindowStart(now: number = Date.now()): Date {
  return new Date(now - RISK_WINDOW_HOURS * 60 * 60 * 1000);
}

/**
 * Units to move for one exact variant selection. New products resolve this to
 * a combination counter; legacy products still resolve it to any per-option
 * counters the seller chose to track.
 */
interface VariantDeduction {
  productId: string;
  variantPick: Record<string, string>;
  combinationId?: string | null;
  units: number;
}

/** Priced line items + stock deductions computed for one checkout. */
interface CheckoutCart {
  /** Order total in cents including delivery (lines always sum to this). */
  totalCents: number;
  /** Delivery charge included in the total (0 = free delivery). */
  deliveryCents: number;
  /** Physical units leaving stock - shown as the order's qty. */
  totalUnits: number;
  /** Per-product stock decrements to apply. */
  deductions: { productId: string; units: number }[];
  /** Per-option decrements, on top of the product-level ones above. */
  variantDeductions: VariantDeduction[];
  lines: {
    productId: string | null;
    name: string;
    qty: number;
    /**
     * Physical units this line takes out of stock - `qty` × the pack size,
     * so it only differs from `qty` for multi-buy packs. Null on the lines
     * that aren't stock at all (delivery, coupon, combo adjustment).
     */
    units: number | null;
    unitPriceCents: number;
    variant: string | null;
    /** `{ groupId: optionId }` of what was picked - null when no variants. */
    variantPick: Record<string, string> | null;
    /** Exact matrix row used; null identifies legacy per-option inventory. */
    variantCombinationId?: string | null;
  }[];
}

@Injectable()
export class OrdersService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrdersService.name);
  private webhookSweepTimer?: NodeJS.Timeout;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly customers: CustomersService,
    private readonly risk: RiskService,
    private readonly phoneProof: PhoneProofService,
    private readonly emailProof: EmailProofService,
    private readonly paymentMethods: PaymentMethodsService,
    private readonly notifications: NotificationsService,
    private readonly gatewayCheckout: GatewayCheckoutService,
    private readonly carrybee: CarrybeeService,
    private readonly steadfast: SteadfastService,
    private readonly pathao: PathaoService,
    private readonly courierSettings: CourierSettingsService,
    private readonly courierStores: ShopCourierStoresService,
    private readonly config: ConfigService,
    private readonly messages: MessagesService,
    private readonly shopCoupons: ShopCouponsService,
  ) {}

  onModuleInit(): void {
    // Picks up callbacks whose inline processing failed. Nothing depends on
    // this for the happy path - it exists so a transient fault costs a delay
    // rather than a delivery nobody ever hears about.
    this.webhookSweepTimer = setInterval(() => {
      void this.sweepCourierWebhooks();
    }, WEBHOOK_SWEEP_INTERVAL_MS);
    this.webhookSweepTimer.unref();
    void this.sweepCourierWebhooks();
  }

  onModuleDestroy(): void {
    clearInterval(this.webhookSweepTimer);
  }

  /**
   * Inline product-page checkout - a single product (with optional variant
   * selection and multi-buy pack) or a combo offer. Runs in a transaction
   * that locks the shop row, serializing checkouts per shop so reference
   * allocation and stock arithmetic cannot race; stock updates are still
   * guarded (`stock >= n`) as defense in depth.
   *
   * Payment truth: COD and direct-transfer methods create the order as
   * 'Due' (money not yet verified in hand); a gateway method creates it as
   * 'Pending' and returns a `paymentUrl` to the hosted checkout (bKash or
   * SSLCommerz) - the order only becomes 'Paid' when that gateway confirms
   * the money. With the 15% pre-payment plan the gateway collects only the
   * advance and the order lands on 'Due' for the balance.
   */
  /**
   * Which identity steps this checkout will ask for, so the storefront can say
   * so before the buyer hits the button rather than after.
   * Advisory only - `checkout` re-runs the same assessment and enforces it.
   */
  async preflight(
    dto: { shopId: string; phone?: string; email?: string },
    caller: CheckoutCaller,
  ): Promise<CheckoutRisk> {
    const risk = await this.risk.assessCheckout({
      phone: dto.phone,
      email: dto.email,
      ip: caller.ip,
      device: caller.device,
      accountId: caller.accountId,
    });
    // Do not advertise a step the buyer could not complete.
    return this.phoneProof.canDeliver
      ? risk
      : { ...risk, requirePhoneVerification: false };
  }

  async checkout(
    dto: CheckoutDto,
    caller: CheckoutCaller = { ip: null, device: null, accountId: null },
  ): Promise<CheckoutResultResponse> {
    // Ahead of the identity gates on purpose: being told the order cannot be
    // placed is worth knowing before being asked to sign in and prove a phone
    // for it. Re-run under the shop lock below, which is what makes it
    // race-proof - this pass is for the buyer, that one is for correctness.
    await this.assertNotOrderedRecently(
      this.db,
      dto.shopId,
      dto.contact,
      await this.checkoutProductIds(dto),
      caller.accountId,
    );

    /**
     * Identity gates, before any of the pricing work. Neither one refuses the
     * order or narrows how it may be paid for - they ask a buyer repeating
     * inside the risk window to say who they are, and the codes are what the
     * storefront switches on to open the right prompt. Answer both and the
     * same order goes through unchanged.
     */
    const subject = {
      phone: dto.contact.phone,
      email: dto.contact.email,
      ip: caller.ip,
      device: caller.device,
      accountId: caller.accountId,
    };
    const risk = await this.risk.assessCheckout(subject);

    if (risk.requireLogin) {
      throw new ForbiddenException({
        code: 'SIGN_IN_REQUIRED',
        message:
          'Please sign in to confirm this order - another order was just placed with these details.',
      });
    }
    // Only ask for a code that can actually be delivered. With no SMS gateway
    // configured this step would be a wall with no door, and being signed in
    // is already the larger part of the proof - so it is skipped rather than
    // turned into a dead end.
    if (
      risk.requirePhoneVerification &&
      this.phoneProof.canDeliver &&
      !(await this.phoneProof.holds(dto.phoneProof, dto.contact.phone))
    ) {
      throw new ForbiddenException({
        code: 'PHONE_VERIFICATION_REQUIRED',
        message: 'Please confirm your phone number to place this order.',
      });
    }
    // The catalog is platform-managed: the code must be live right now, so a
    // method removed by an operator disappears from checkout immediately.
    const method = await this.paymentMethods.findEnabledByCode(
      dto.paymentMethod,
    );
    if (!method) {
      throw new BadRequestException(
        'That payment method is not available - please pick another.',
      );
    }
    await this.assertGatewayAvailable(method);
    const usesCodProtection = dto.paymentPlan !== undefined;
    const wantsCodAdvance = dto.paymentPlan === 'cod_advance';
    const checkoutKind = usesCodProtection ? 'cod' : method.kind;
    if (usesCodProtection && method.kind === 'cod') {
      throw new BadRequestException(
        'Choose bKash or SSLCommerz for the 15% advance payment.',
      );
    }

    /**
     * Money is about to change hands, so the address the receipt, the payment
     * trail and any refund conversation depend on has to be one the buyer can
     * actually open. Applies to the 15% advance exactly as it does to paying
     * in full - both take money now - and never to plain Cash on Delivery,
     * where nothing is collected until the parcel is in their hands.
     *
     * A signed-in buyer whose account email is already verified has answered
     * this once and is not asked again; everyone else answers a code or
     * follows the emailed link, and carries the proof back on the retry.
     */
    if (method.kind !== 'cod') {
      const orderEmail = dto.contact.email?.trim();
      if (!orderEmail) {
        throw new ForbiddenException({
          code: 'EMAIL_VERIFICATION_REQUIRED',
          message: 'Add your email address to pay online.',
        });
      }
      if (
        !(await this.emailProof.satisfies(
          orderEmail,
          dto.emailProof,
          caller.accountId,
        ))
      ) {
        throw new ForbiddenException({
          code: 'EMAIL_VERIFICATION_REQUIRED',
          message: 'Please confirm your email address to pay online.',
        });
      }
    }
    // Exactly one of the three order shapes: a single product, a combo, or a
    // cart of products (all from this one shop).
    const shapes = [dto.productId, dto.comboId, dto.items].filter(Boolean);
    if (shapes.length !== 1) {
      throw new BadRequestException(
        'Provide a product, a combo, or a cart of items to order.',
      );
    }

    const payStatus = method.gateway !== 'none' ? 'Pending' : 'Due';

    const order = await this.db.transaction(async (tx) => {
      // Lock the shop row: all concurrent checkouts for this shop queue here,
      // which makes the "#NNNN" reference and stock math race-free.
      const [shop] = await tx
        .select({
          live: shops.live,
          plan: shops.plan,
          ownerId: shops.ownerId,
          codAdvanceEnabled: shops.codAdvanceEnabled,
          paymentMethods: shops.paymentMethods,
        })
        .from(shops)
        .where(eq(shops.id, dto.shopId))
        .for('update');
      // A switched-off shop is closed to buyers - no orders either.
      if (!shop?.live) {
        throw new ForbiddenException('This shop is currently offline.');
      }
      if (!shop.paymentMethods.includes(checkoutKind)) {
        throw new BadRequestException(
          'That payment method is not enabled for this shop - please pick another.',
        );
      }
      if (usesCodProtection && !shop.codAdvanceEnabled) {
        throw new BadRequestException(
          'This shop does not currently offer 15% advance payment.',
        );
      }

      await this.assertNotOwnShop(
        tx,
        shop.ownerId,
        dto.contact,
        caller.accountId,
      );

      // Free tier: a shop may take 10 orders as a trial; the order that fills
      // the last slot still goes through, then the shop is deactivated until
      // the seller subscribes.
      let priorOrders = 0;
      if (shop.plan === 'free') {
        priorOrders = await this.lifetimeOrderCount(tx, dto.shopId);
        if (priorOrders >= FREE_ORDER_CAP) {
          throw new ForbiddenException(FREE_TIER_LIMIT_MESSAGE);
        }
      }

      // Pre-paid credit, checked under the same lock for the same reason the
      // free quota is: the hourly billing sweep would let a shop sell far past
      // a balance it has already paid for. The order that takes the balance to
      // zero still completes - it is the next one that is refused.
      const credit = await creditPosition(tx, dto.shopId);
      if (credit && credit.balanceCents <= 0) {
        throw new ForbiddenException(CREDIT_EXHAUSTED_MESSAGE);
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

      // Build the priced line items + stock deductions for the picked flow.
      // A partial payment is still the product's COD track; bKash/card only
      // collects the advance. Validate product availability against COD rather
      // than requiring sellers to enable full online payment too.
      const cart = dto.items
        ? await this.buildItemsCart(tx, dto, checkoutKind)
        : dto.comboId
          ? await this.buildComboCart(tx, dto, checkoutKind)
          : await this.buildProductCart(tx, dto, checkoutKind);

      // The authoritative pass, under the shop lock that serializes checkouts
      // for this shop - which is what actually stops a double-tapped button
      // placing two. Reads the priced cart, so it sees a combo's members
      // however the request named them. Before any stock moves.
      await this.assertNotOrderedRecently(
        tx,
        dto.shopId,
        dto.contact,
        [
          ...new Set(
            cart.lines
              .map((l) => l.productId)
              .filter((id): id is string => id !== null),
          ),
        ],
        caller.accountId,
      );

      // A coupon takes money off the item subtotal (never delivery - the
      // seller still owes the courier that). A code that doesn't apply is
      // ignored rather than failing the order: the storefront previews it and
      // shows the exact discount before the buyer commits, so a race here
      // (the code expiring mid-checkout) should still place the order.
      const applied = await this.applyCoupon(tx, dto, cart);
      const advanceCents = wantsCodAdvance
        ? Math.max(1, Math.round((cart.totalCents * 15) / 100))
        : 0;

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
      // Options that carry their own counter come off it too - the product
      // total above is the ceiling, this is the per-choice availability.
      await this.applyVariantStock(tx, cart.variantDeductions, -1);

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
          // Who placed it, when they were signed in. This is what makes the
          // order theirs for good - the email below records what they typed,
          // not who they are.
          userId: caller.accountId,
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
          advanceCents,
          channel: 'Store',
          couponCode: applied?.coupon.code ?? null,
          discountCents: applied?.discountCents ?? 0,
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
          units: line.units,
          unitPriceCents: line.unitPriceCents,
          variant: line.variant,
          variantPick: line.variantPick,
          variantCombinationId: line.variantCombinationId ?? null,
        })),
      );

      // Claim the redemption under the same lock that priced it, so the last
      // use of a capped code can't be handed to two buyers at once.
      if (applied) {
        await this.shopCoupons.redeem(tx, applied.coupon, {
          orderId: order.id,
          phone: normalizeCouponPhone(dto.contact.phone),
          discountCents: applied.discountCents,
        });
      }

      // Filling the free-tier order quota deactivates the shop (this order
      // stands).
      if (shop.plan === 'free' && priorOrders + 1 >= FREE_ORDER_CAP) {
        await tx
          .update(shops)
          .set({ live: false })
          .where(eq(shops.id, dto.shopId));
      }

      // Same for the order that spends the last of the credit: it stands, and
      // the shop closes behind it until the seller tops up.
      if (credit && credit.balanceCents - order.totalCents <= 0) {
        await tx
          .update(shops)
          .set({ live: false })
          .where(eq(shops.id, dto.shopId));
        await tx
          .update(subscriptions)
          .set({ creditExhaustedAt: new Date() })
          .where(eq(subscriptions.shopId, dto.shopId));
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

    // The order stands, so it counts against the next one from this buyer.
    // Recorded after the commit and never allowed to fail the checkout: a
    // ledger write is not worth losing a placed order over.
    void this.risk.record('order', subject).catch(() => undefined);

    // Hosted-gateway leg runs after the commit (never hold a DB transaction
    // across an external HTTP call). If the gateway cannot open a payment the
    // pending order is voided again - stock and customer stats roll back.
    //
    // The amount is the advance when the buyer picked the 15% pre-payment and
    // the full total otherwise, so the same branch serves both plans.
    if (method.gateway !== 'none') {
      try {
        const paymentUrl = await this.openGatewayPayment(
          order,
          method.gateway,
          order.advanceCents || order.totalCents,
        );
        return this.checkoutResult(order, dto, { paymentUrl });
      } catch (err) {
        await this.voidPendingOrder(order.id);
        throw err;
      }
    }

    return this.checkoutResult(order, dto, {});
  }

  /**
   * Evaluate `dto.couponCode` against the priced cart and, if it applies, add
   * the negative discount line and lower the total. Returns what was applied
   * so the caller can record it on the order and claim the redemption.
   *
   * The discount line keeps the invariant every other line relies on: the
   * line totals always sum to the order total, which is what cancel-restock,
   * settlements and reporting read.
   */
  private async applyCoupon(
    tx: OrdersTx,
    dto: CheckoutDto,
    cart: CheckoutCart,
  ): Promise<{ coupon: ShopCouponRow; discountCents: number } | null> {
    if (!dto.couponCode?.trim()) return null;

    const result = await this.shopCoupons.evaluate(
      tx,
      dto.shopId,
      dto.couponCode,
      this.couponBasis(cart, {
        comboId: dto.comboId,
        phone: normalizeCouponPhone(dto.contact.phone),
      }),
    );
    if (!('discountCents' in result)) return null;

    cart.lines.push({
      productId: null,
      name: `Coupon ${result.coupon.code}`.slice(0, 200),
      qty: 1,
      units: null,
      unitPriceCents: -result.discountCents,
      variant: result.coupon.description?.slice(0, 240) ?? null,
      variantPick: null,
    });
    cart.totalCents -= result.discountCents;
    return result;
  }

  /**
   * Describe a priced cart to the coupon rules. `itemsSubtotalCents` excludes
   * delivery (and is already net of any combo discount); `valueByProduct` is
   * what a product-scoped code measures itself against.
   */
  private couponBasis(
    cart: CheckoutCart,
    opts: { comboId?: string; phone: string },
  ): CouponBasis {
    const valueByProduct = new Map<string, number>();
    for (const line of cart.lines) {
      if (!line.productId) continue;
      valueByProduct.set(
        line.productId,
        (valueByProduct.get(line.productId) ?? 0) +
          line.unitPriceCents * line.qty,
      );
    }
    return {
      itemsSubtotalCents: cart.totalCents - cart.deliveryCents,
      valueByProduct,
      comboId: opts.comboId,
      phone: opts.phone,
    };
  }

  /**
   * Storefront preview: price the buyer's cart exactly as checkout would and
   * report what the code takes off, without touching stock or redemptions.
   *
   * It runs the same cart builders as the real checkout, so the number shown
   * is the number charged. Payment-method checks are skipped - the buyer may
   * not have picked one yet, and the method can't change the discount.
   */
  async quoteCoupon(dto: CouponQuoteDto): Promise<CouponQuoteResponse> {
    const shapes = [dto.productId, dto.comboId, dto.items].filter(Boolean);
    if (shapes.length !== 1) {
      throw new BadRequestException(
        'Provide a product, a combo, or a cart of items to price.',
      );
    }
    // A read-only transaction: the builders take a tx, and rolling it back
    // guarantees a preview can never leave anything behind.
    return this.db.transaction(async (tx) => {
      const checkoutish = {
        ...dto,
        address: { line: '', area: dto.area ?? '', pincode: '' },
      } as unknown as CheckoutDto;

      const cart = dto.items
        ? await this.buildItemsCart(tx, checkoutish, null)
        : dto.comboId
          ? await this.buildComboCart(tx, checkoutish, null)
          : await this.buildProductCart(tx, checkoutish, null);

      const result = await this.shopCoupons.evaluate(
        tx,
        dto.shopId,
        dto.code,
        this.couponBasis(cart, {
          comboId: dto.comboId,
          phone: normalizeCouponPhone(dto.phone),
        }),
      );
      return this.shopCoupons.toQuote(dto.code, result);
    });
  }

  /**
   * Place an order from an accepted chat offer.
   *
   * Deliberately parallel to `checkout` - same shop lock, same guarded stock
   * decrement, same customer stats, notifications and free-tier cap - with
   * one difference: the line prices come from the offer, not the catalog.
   * That is the whole point of an offer, and it's why this can't just call
   * `checkout`, which re-prices from the catalog and would silently discard
   * whatever the seller agreed.
   *
   * Stock is still taken at acceptance, never at offer time, so a standing
   * offer can never oversell.
   */
  async placeFromOffer(args: {
    offer: {
      id: string;
      shopId: string;
      items: {
        productId: string;
        name: string;
        qty: number;
        unitPriceCents: number;
      }[];
      deliveryCents: number;
      totalCents: number;
    };
    buyer: {
      id: string;
      name: string;
      email: string | null;
      phone: string | null;
    };
    address: { line: string; area: string; pincode?: string };
    paymentMethod: string;
    phone?: string;
  }): Promise<{ order: OrderRow; paymentUrl?: string }> {
    const { offer } = args;
    const method = await this.paymentMethods.findEnabledByCode(
      args.paymentMethod,
    );
    if (!method) {
      throw new BadRequestException(
        'That payment method is not available - please pick another.',
      );
    }
    await this.assertGatewayAvailable(method);
    const phone = args.phone?.trim() || args.buyer.phone || '';
    if (!phone) {
      throw new BadRequestException(
        'A phone number is required to place this order.',
      );
    }
    const email = args.buyer.email ?? `${phone}@phone.local`;
    const payStatus = method.gateway !== 'none' ? 'Pending' : 'Due';

    const order = await this.db.transaction(async (tx) => {
      const [shop] = await tx
        .select({
          live: shops.live,
          plan: shops.plan,
          ownerId: shops.ownerId,
          paymentMethods: shops.paymentMethods,
        })
        .from(shops)
        .where(eq(shops.id, offer.shopId))
        .for('update');
      if (!shop?.live) {
        throw new ForbiddenException('This shop is currently offline.');
      }
      if (!shop.paymentMethods.includes(method.kind)) {
        throw new BadRequestException(
          'That payment method is not enabled for this shop - please pick another.',
        );
      }
      if (shop.ownerId === args.buyer.id) {
        throw new ForbiddenException(
          'You cannot accept an order offer from your own shop.',
        );
      }

      let priorOrders = 0;
      if (shop.plan === 'free') {
        priorOrders = await this.lifetimeOrderCount(tx, offer.shopId);
        if (priorOrders >= FREE_ORDER_CAP) {
          throw new ForbiddenException(FREE_TIER_LIMIT_MESSAGE);
        }
      }

      // Pre-paid credit, same rule as the storefront checkout: an accepted
      // chat offer is still a sale, and still has to be paid for.
      const credit = await creditPosition(tx, offer.shopId);
      if (credit && credit.balanceCents <= 0) {
        throw new ForbiddenException(CREDIT_EXHAUSTED_MESSAGE);
      }

      // Re-read the products under the lock: an offer can sit in a thread for
      // days, and the item may since have been deleted, delisted, or switched
      // to a payment kind that excludes the buyer's choice.
      const ids = [...new Set(offer.items.map((i) => i.productId))];
      const rows = await tx.query.products.findMany({
        where: and(
          inArray(products.id, ids),
          eq(products.shopId, offer.shopId),
        ),
      });
      const byId = new Map(rows.map((p) => [p.id, p]));

      const lines: CheckoutCart['lines'] = [];
      const unitsByProduct = new Map<string, number>();
      for (const item of offer.items) {
        const product = byId.get(item.productId);
        if (!product || product.listingType !== 'sale') {
          throw new ConflictException(
            `“${item.name}” is no longer available - ask the seller for a new offer.`,
          );
        }
        if ((product.variantCombinations ?? []).length) {
          throw new ConflictException(
            `“${product.name}” now has buyer-selectable variants - ask the seller for a new offer.`,
          );
        }
        unitsByProduct.set(
          product.id,
          (unitsByProduct.get(product.id) ?? 0) + item.qty,
        );
        lines.push({
          productId: product.id,
          name: item.name,
          qty: item.qty,
          // Offers are priced per unit - no packs, so picks are units.
          units: item.qty,
          unitPriceCents: item.unitPriceCents,
          variant: null,
          // A seller's chat offer names whole products, never a variant.
          variantPick: null,
        });
      }
      for (const [productId, units] of unitsByProduct) {
        const product = byId.get(productId)!;
        if (product.stock < units) {
          throw new ConflictException(
            `Not enough stock of ${product.name} - ask the seller for a new offer.`,
          );
        }
      }

      if (offer.deliveryCents > 0) {
        lines.push({
          productId: null,
          name: DELIVERY_LINE_NAME,
          qty: 1,
          units: null,
          unitPriceCents: offer.deliveryCents,
          variant: null,
          variantPick: null,
        });
      }

      for (const [productId, units] of unitsByProduct) {
        const updated = await tx
          .update(products)
          .set({ stock: sql`${products.stock} - ${units}` })
          .where(and(eq(products.id, productId), gte(products.stock, units)))
          .returning({ id: products.id });
        if (!updated.length) {
          throw new ConflictException('Not enough stock for this offer');
        }
      }

      const placedAt = new Date();
      const reference = await this.nextReference(tx, offer.shopId);
      const totalUnits = [...unitsByProduct.values()].reduce(
        (a, b) => a + b,
        0,
      );

      const customerId = await this.customers.recordOrder(tx, {
        shopId: offer.shopId,
        name: args.buyer.name,
        email,
        phone,
        city: args.address.area,
        amountCents: offer.totalCents,
        placedAt,
      });

      const [row] = await tx
        .insert(orders)
        .values({
          reference,
          shopId: offer.shopId,
          customerId,
          // An offer is only ever accepted by a signed-in buyer.
          userId: args.buyer.id,
          customerName: args.buyer.name,
          email,
          phone,
          qty: totalUnits,
          totalCents: offer.totalCents,
          deliveryCents: offer.deliveryCents,
          status: 'New',
          pay: payStatus,
          paymentMethod: args.paymentMethod,
          channel: 'Store',
          address: {
            line: args.address.line,
            area: args.address.area,
            pincode: args.address.pincode ?? '',
          },
          placedAt,
        })
        .returning();

      await tx.insert(orderItems).values(
        lines.map((line) => ({
          orderId: row.id,
          productId: line.productId,
          name: line.name,
          qty: line.qty,
          units: line.units,
          unitPriceCents: line.unitPriceCents,
          variant: line.variant,
          variantPick: line.variantPick,
        })),
      );

      if (shop.plan === 'free' && priorOrders + 1 >= FREE_ORDER_CAP) {
        await tx
          .update(shops)
          .set({ live: false })
          .where(eq(shops.id, offer.shopId));
      }

      // The order that spends the last of the credit stands; the shop closes
      // behind it until the seller tops up.
      if (credit && credit.balanceCents - offer.totalCents <= 0) {
        await tx
          .update(shops)
          .set({ live: false })
          .where(eq(shops.id, offer.shopId));
        await tx
          .update(subscriptions)
          .set({ creditExhaustedAt: new Date() })
          .where(eq(subscriptions.shopId, offer.shopId));
      }

      if (payStatus !== 'Pending') {
        await this.notifications.orderEvent(
          tx,
          row,
          'order_placed',
          `Order ${row.reference} placed`,
          `Your order has been placed. ${
            method.kind === 'cod'
              ? 'Pay in cash when it arrives.'
              : 'The seller will confirm your payment shortly.'
          }`,
        );
      }
      return row;
    });

    // Hosted-gateway leg runs after the commit, exactly as in `checkout`. An
    // accepted offer is always paid in full - there is no advance plan here.
    if (method.gateway !== 'none') {
      try {
        const paymentUrl = await this.openGatewayPayment(
          order,
          method.gateway,
          order.totalCents,
        );
        return { order, paymentUrl };
      } catch (err) {
        await this.voidPendingOrder(order.id);
        throw err;
      }
    }
    return { order };
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
      qty: order.qty,
      eta: 'Within 2-3 days',
      payStatus: order.pay,
      amountDueNow: (order.advanceCents || order.totalCents) / 100,
      codDue: order.advanceCents
        ? (order.totalCents - order.advanceCents) / 100
        : 0,
      ...extra,
    };
  }

  /**
   * Refuse a gateway method the platform cannot actually collect through, so
   * a half-configured console never strands a buyer on a dead payment page.
   * The message names the route the buyer chose, not the plumbing behind it.
   */
  private async assertGatewayAvailable(
    method: PaymentMethodRow,
  ): Promise<void> {
    if (method.gateway === 'none') return;
    if (await this.gatewayCheckout.isConfigured(method.gateway)) return;
    throw new BadRequestException(
      method.gateway === 'bkash'
        ? 'bKash payments are temporarily unavailable - please pick another method.'
        : 'Card payments are temporarily unavailable - please pick another method.',
    );
  }

  /**
   * Open a hosted payment for a committed-but-pending order and return the
   * page to send the buyer to. `amountCents` is what is collected now - the
   * full total, or just the advance on a 15% pre-payment order.
   *
   * Everything the gateway needs about the buyer is read off the order row
   * rather than the request, so both checkout paths (storefront and accepted
   * chat offer) hand over exactly what was actually recorded.
   *
   * Throws on refusal; the caller voids the pending order.
   */
  private async openGatewayPayment(
    order: OrderRow,
    gateway: CollectingGateway,
    amountCents: number,
  ): Promise<string> {
    const address = order.address;
    const { paymentUrl } = await this.gatewayCheckout.open({
      purpose: 'order',
      gateway,
      amountCents,
      reference: order.reference,
      entityId: order.id,
      productName: `Order ${order.reference}`,
      orderId: order.id,
      customer: {
        name: order.customerName,
        email: order.email,
        phone: order.phone ?? '',
        address: address?.line ?? '',
        city: address?.area ?? '',
        postcode: address?.pincode ?? '',
      },
    });
    return paymentUrl;
  }

  /**
   * A seller cannot buy from their own shop.
   *
   * Checkout is public - most orders arrive with no session at all - so the
   * buyer is identified the only way a guest ever is: the contact details on
   * the order. Matching either the owner's email or their phone is enough,
   * because both are unique per account and both are what the seller would
   * naturally type into their own storefront.
   *
   * A signed-in caller is matched on their account id as well, which is the
   * one identifier they cannot type their way around: a seller browsing their
   * own storefront while logged in is caught whatever contact details they
   * put in the form.
   *
   * This is a self-dealing guard, not a security boundary: a seller who wants
   * to place an order against themselves can sign out and use another address.
   * What it stops is the accidental case, and the obvious inflation of a
   * shop's own order count and review eligibility.
   */
  private async assertNotOwnShop(
    tx: OrdersTx,
    ownerId: string,
    contact: { email?: string; phone: string },
    accountId: string | null = null,
  ): Promise<void> {
    if (accountId && accountId === ownerId) {
      throw new ForbiddenException(
        'You cannot place an order in your own shop.',
      );
    }
    const [owner] = await tx
      .select({ email: users.email, phone: users.phone })
      .from(users)
      .where(eq(users.id, ownerId));
    if (!owner) return;

    const email = contact.email?.trim().toLowerCase();
    const phone = normalizePhone(contact.phone);
    const sameEmail =
      !!email && !!owner.email && owner.email.toLowerCase() === email;
    const samePhone = !!phone && normalizePhone(owner.phone) === phone;

    if (sameEmail || samePhone) {
      throw new ForbiddenException(
        'You cannot place an order in your own shop.',
      );
    }
  }

  /**
   * The products this checkout is about to buy, read straight off the request.
   *
   * Exists so the duplicate check can run *before* the identity gates. Almost
   * every same-item repeat is also a same-contact repeat, so without this the
   * buyer would be made to sign in and answer an SMS code only to be told the
   * order was never going to be placed - three prompts to reach a refusal.
   *
   * A combo names its members rather than a product, so that one shape needs a
   * lookup; the other two are already in the request.
   */
  private async checkoutProductIds(dto: CheckoutDto): Promise<string[]> {
    if (dto.items) return dto.items.map((i) => i.productId);
    if (dto.productId) return [dto.productId];
    if (dto.comboId) {
      const combo = await this.db.query.combos.findFirst({
        where: and(eq(combos.id, dto.comboId), eq(combos.shopId, dto.shopId)),
        with: { items: { columns: { productId: true } } },
      });
      return combo?.items.map((i) => i.productId) ?? [];
    }
    return [];
  }

  /**
   * One buyer, one order of a given item per {@link RISK_WINDOW_HOURS}.
   *
   * Aimed at the duplicate nobody meant to place - a double-tapped button, a
   * page reopened from history, a buyer who forgot they already ordered this
   * morning. A second copy of the same thing hours later is far more often a
   * mistake than an intention, and a seller shipping two is the one who
   * absorbs it.
   *
   * So it is refused rather than swallowed, but with the door left open: the
   * storefront turns this code into a prompt offering the seller's chat, which
   * is where a buyer who genuinely wants two says so. The window then lapses
   * on its own.
   *
   * Matched on the contact details, like every other buyer-history question
   * here - orders carry no account id, and a regular checking out as a guest
   * is still the same person.
   */
  private async assertNotOrderedRecently(
    executor: OrdersTx | DrizzleDB,
    shopId: string,
    contact: { email?: string; phone: string },
    productIds: string[],
    accountId: string | null = null,
  ): Promise<void> {
    if (!productIds.length) return;

    const email = contact.email?.trim().toLowerCase();
    const phone = normalizePhone(contact.phone);
    const who = [
      // The account, when there is one: changing the email on the form is
      // otherwise a way straight past this check.
      accountId ? eq(orders.userId, accountId) : undefined,
      email ? sql`lower(${orders.email}) = ${email}` : undefined,
      phone
        ? sql`regexp_replace(coalesce(${orders.phone}, ''), '\\D', '', 'g') like ${'%' + phone}`
        : undefined,
    ].filter(Boolean);
    if (!who.length) return;

    // A cancelled order is one that never happened, so it must not stand in
    // the way of ordering the same thing again.
    const [clash] = await executor
      .select({ name: orderItems.name })
      .from(orderItems)
      .innerJoin(orders, eq(orderItems.orderId, orders.id))
      .where(
        and(
          eq(orders.shopId, shopId),
          ne(orders.status, 'Cancelled'),
          gte(orders.placedAt, repeatItemWindowStart()),
          inArray(orderItems.productId, productIds),
          or(...who),
        ),
      )
      .limit(1);

    if (clash) {
      throw new ForbiddenException({
        code: 'ALREADY_ORDERED_RECENTLY',
        message: `You have already ordered ${clash.name} recently. To buy it again, please try later or message the seller.`,
      });
    }
  }

  /** Lifetime orders (everything not cancelled) - the free-tier cap metric. */
  private async lifetimeOrderCount(
    executor: OrdersTx | DrizzleDB,
    shopId: string,
  ): Promise<number> {
    const [{ n }] = await executor
      .select({
        n: sql<string>`count(*) filter (where ${orders.status} <> 'Cancelled')`,
      })
      .from(orders)
      .where(eq(orders.shopId, shopId));
    return Number(n);
  }

  /**
   * Price one picked line of a product: the variant selection (one option per
   * group the product defines) and an optional multi-buy pack. Deltas apply
   * per unit, so a pack of N carries N × delta on top of the pack price.
   * Stock is *not* checked here - the caller sums the units a product needs
   * across every line first, then checks once.
   */
  private priceProductPick(
    product: ProductRow,
    pick: { qty: number; variant?: Record<string, string>; packId?: string },
    _payKind: string | null,
  ): {
    line: CheckoutCart['lines'][number];
    units: number;
    variantPick: Record<string, string>;
    combinationId: string | null;
  } {
    // Showcase items are advertised only - the sale happens offline, so
    // online checkout is never allowed for them.
    if (product.listingType === 'showcase') {
      throw new ConflictException(
        `“${product.name}” cannot be ordered online - please contact the seller.`,
      );
    }
    // One option per variant group is mandatory once a product defines groups.
    const parts: string[] = [];
    const variantPick: Record<string, string> = {};
    let deltaCents = 0;
    for (const group of product.variantGroups ?? []) {
      const option = group.options.find(
        (o) => o.id === pick.variant?.[group.id],
      );
      if (!option) {
        throw new BadRequestException(
          `Please choose an option for “${group.name}” on ${product.name}`,
        );
      }
      deltaCents += option.priceDeltaCents;
      parts.push(`${group.name}: ${option.label}`);
      variantPick[group.id] = option.id;
    }

    // Combination products price and stock the exact cross-group selection.
    // Empty preserves the legacy option-delta behavior below.
    const combination = (product.variantCombinations ?? []).find((c) =>
      Object.entries(variantPick).every(
        ([groupId, optionId]) => c.optionIds[groupId] === optionId,
      ),
    );
    if ((product.variantCombinations ?? []).length && !combination) {
      throw new ConflictException(
        'That option combination is not sold - please pick another.',
      );
    }
    if (combination && !combination.available) {
      throw new ConflictException(
        'That option combination is unavailable - please pick another.',
      );
    }
    if (combination) deltaCents = combination.priceCents - product.priceCents;

    // Not every pair of options exists: a colour may only be made in some of
    // the configurations. The storefront greys those out, so reaching here
    // means a stale page or a hand-made request - either way the combination
    // can't be shipped, so it can't be sold.
    for (const group of combination ? [] : (product.variantGroups ?? [])) {
      const option = group.options.find((o) => o.id === variantPick[group.id])!;
      if (!option.onlyWith?.length) continue;
      const partner = (product.variantGroups ?? []).find(
        (g) => g.id !== group.id,
      );
      const partnerPick = partner ? variantPick[partner.id] : undefined;
      if (partnerPick && !option.onlyWith.includes(partnerPick)) {
        const chosen = partner?.options.find((o) => o.id === partnerPick);
        throw new ConflictException(
          `“${option.label}” isn’t available with ${chosen?.label ?? 'that option'} - please pick another combination.`,
        );
      }
    }

    // A pack re-prices the line: qty counts packs, each consuming pack.units.
    let unitsPerPick = 1;
    let unitPriceCents = Math.max(0, product.priceCents + deltaCents);
    if (pick.packId) {
      const pack = (product.packs ?? []).find((p) => p.id === pick.packId);
      if (!pack) {
        throw new BadRequestException(
          'That pack is no longer available - please reload and pick again.',
        );
      }
      unitsPerPick = pack.units;
      unitPriceCents = Math.max(0, pack.priceCents + pack.units * deltaCents);
      parts.push(pack.label.trim() || `Pack of ${pack.units}`);
    }

    if (combination && combination.stock < unitsPerPick * pick.qty) {
      throw new ConflictException(
        `Only ${combination.stock} left of that combination - please lower the quantity.`,
      );
    }

    return {
      line: {
        productId: product.id,
        name: product.name,
        qty: pick.qty,
        units: unitsPerPick * pick.qty,
        unitPriceCents,
        variant: parts.length ? parts.join(' · ').slice(0, 240) : null,
        variantPick: Object.keys(variantPick).length ? variantPick : null,
        variantCombinationId: combination?.id ?? null,
      },
      units: unitsPerPick * pick.qty,
      variantPick,
      combinationId: combination?.id ?? null,
    };
  }

  /**
   * Take units off (or, with a positive `sign`, hand them back to) whichever
   * inventory model the product uses: the exact-row counters in
   * `products.variant_combinations`, or the legacy per-option counters inside
   * `products.variant_groups`.
   *
   * The counters live in jsonb, so there is no column to guard with a `>=`
   * predicate the way product-level stock is. Instead the product row is
   * locked before the read-modify-write, which serializes concurrent
   * checkouts of the same product regardless of which shop lock they came
   * through. Deltas for the same option are summed first so a cart holding
   * the same variant on two lines is checked once, against the total.
   */
  private async applyVariantStock(
    tx: OrdersTx,
    deductions: VariantDeduction[],
    sign: 1 | -1,
  ): Promise<void> {
    if (!deductions.length) return;
    // Two lines that moved the same thing are one movement, so the check runs
    // against their combined units. The picks are keyed on sorted entries
    // rather than the object's own order: a pick read back out of jsonb comes
    // with Postgres' key order, not the one checkout wrote it in.
    const byProduct = new Map<string, Map<string, VariantDeduction>>();
    for (const d of deductions) {
      const key = d.combinationId
        ? `c:${d.combinationId}`
        : `o:${Object.entries(d.variantPick)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([g, o]) => `${g}=${o}`)
            .join('|')}`;
      const forProduct =
        byProduct.get(d.productId) ?? new Map<string, VariantDeduction>();
      const seen = forProduct.get(key);
      forProduct.set(
        key,
        seen ? { ...seen, units: seen.units + d.units } : { ...d },
      );
      byProduct.set(d.productId, forProduct);
    }

    // Always take the row locks in id order: a checkout and a cancellation
    // touching the same two products can then never hold half of each other's
    // locks (the shop lock only serializes checkouts, not cancels).
    for (const [productId, wanted] of [...byProduct].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )) {
      const [row] = await tx
        .select({
          variantGroups: products.variantGroups,
          variantCombinations: products.variantCombinations,
        })
        .from(products)
        .where(eq(products.id, productId))
        .for('update');
      if (!row) continue;

      const moves = [...wanted.values()];
      const combinations = [...(row.variantCombinations ?? [])];
      for (const move of moves) {
        if (!move.combinationId) continue;
        const i = combinations.findIndex((c) => c.id === move.combinationId);
        // The seller reshaped the matrix since the order was placed, so there
        // is no counter left to move. The aggregate recompute below keeps the
        // rows that do still exist honest.
        if (i < 0) continue;
        const current = combinations[i];
        const next = current.stock + sign * move.units;
        if (next < 0) {
          throw new ConflictException(
            `Only ${current.stock} left of that combination - please lower the quantity.`,
          );
        }
        combinations[i] = { ...current, stock: next };
      }

      // Exact-combination orders never touch the legacy per-option counters.
      const perOption = moves.filter((m) => !m.combinationId);
      const groups = (row.variantGroups ?? []).map((g) => ({
        ...g,
        options: g.options.map((o) => {
          const units = perOption.reduce(
            (sum, m) => sum + (m.variantPick[g.id] === o.id ? m.units : 0),
            0,
          );
          // Untouched options, and ones the seller has since stopped tracking,
          // pass through unchanged.
          if (!units || typeof o.stock !== 'number') return o;
          const next = o.stock + sign * units;
          if (next < 0) {
            throw new ConflictException(
              `Only ${o.stock} left of “${o.label}” - please lower the quantity.`,
            );
          }
          return { ...o, stock: next };
        }),
      }));

      await tx
        .update(products)
        .set({
          variantGroups: groups,
          variantCombinations: combinations,
          // Once a product sells exact rows they are the only truth about how
          // much of it exists, so the aggregate is recomputed rather than
          // nudged - that is what keeps it right when a seller disables or
          // deletes a row between checkout and cancellation. A product with no
          // exact rows keeps whatever the caller did to the column itself.
          stock: combinations.length
            ? combinations.reduce(
                (sum, c) => sum + (c.available ? c.stock : 0),
                0,
              )
            : undefined,
        })
        .where(eq(products.id, productId));
    }
  }

  /**
   * Single-product checkout (the product page's inline order card): one
   * priced line plus the product's zone delivery charge.
   */
  private async buildProductCart(
    tx: OrdersTx,
    dto: CheckoutDto,
    payKind: string | null,
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

    const { line, units, variantPick, combinationId } = this.priceProductPick(
      product,
      { qty: dto.qty ?? 1, variant: dto.variant, packId: dto.packId },
      payKind,
    );
    if (product.stock < units) {
      throw new ConflictException('Not enough stock for this quantity');
    }

    const lines: CheckoutCart['lines'] = [line];
    const deliveryCents = this.deliveryFeeCents(dto, [product]);
    this.pushDeliveryLine(lines, deliveryCents, dto);

    return {
      totalCents: line.unitPriceCents * line.qty + deliveryCents,
      deliveryCents,
      totalUnits: units,
      deductions: [{ productId: product.id, units }],
      variantDeductions: Object.keys(variantPick).length
        ? [{ productId: product.id, variantPick, combinationId, units }]
        : [],
      lines,
    };
  }

  /**
   * Cart checkout: several products from one shop in a single order. A cart
   * is per shop by construction (the buyer keeps a separate cart for every
   * shop), and this rejects anything that isn't in `dto.shopId`, so an order
   * can never mix shops. The parcel ships together, so the buyer pays one
   * delivery charge - the highest zone fee among the products in it.
   */
  private async buildItemsCart(
    tx: OrdersTx,
    dto: CheckoutDto,
    payKind: string | null,
  ): Promise<CheckoutCart> {
    const picks = dto.items!;
    const ids = [...new Set(picks.map((i) => i.productId))];
    const rows = await tx.query.products.findMany({
      where: and(inArray(products.id, ids), eq(products.shopId, dto.shopId)),
    });
    const byId = new Map(rows.map((p) => [p.id, p]));
    const missing = ids.find((id) => !byId.has(id));
    if (missing) {
      throw new NotFoundException(
        'One of the items in your cart is no longer available in this shop.',
      );
    }

    const lines: CheckoutCart['lines'] = [];
    // The same product can appear on several lines (different variants), so
    // stock is only sound once every line's units are summed per product.
    const unitsByProduct = new Map<string, number>();
    const variantDeductions: VariantDeduction[] = [];
    for (const pick of picks) {
      const product = byId.get(pick.productId)!;
      const { line, units, variantPick, combinationId } = this.priceProductPick(
        product,
        pick,
        payKind,
      );
      lines.push(line);
      unitsByProduct.set(
        product.id,
        (unitsByProduct.get(product.id) ?? 0) + units,
      );
      if (Object.keys(variantPick).length) {
        variantDeductions.push({
          productId: product.id,
          variantPick,
          combinationId,
          units,
        });
      }
    }
    for (const [productId, units] of unitsByProduct) {
      const product = byId.get(productId)!;
      if (product.stock < units) {
        throw new ConflictException(
          `Not enough stock of ${product.name} for this quantity`,
        );
      }
    }
    const unitsByCombination = new Map<string, number>();
    for (const d of variantDeductions) {
      if (!d.combinationId) continue;
      const key = `${d.productId}:${d.combinationId}`;
      unitsByCombination.set(key, (unitsByCombination.get(key) ?? 0) + d.units);
    }
    for (const [key, units] of unitsByCombination) {
      const separator = key.indexOf(':');
      const product = byId.get(key.slice(0, separator));
      const combination = product?.variantCombinations?.find(
        (c) => c.id === key.slice(separator + 1),
      );
      if (!combination || !combination.available || combination.stock < units) {
        throw new ConflictException(
          `Not enough stock of ${product?.name ?? 'that combination'} for this quantity`,
        );
      }
    }

    const itemsTotalCents = lines.reduce(
      (sum, l) => sum + l.unitPriceCents * l.qty,
      0,
    );
    const deliveryCents = this.deliveryFeeCents(dto, rows);
    this.pushDeliveryLine(lines, deliveryCents, dto);

    return {
      totalCents: itemsTotalCents + deliveryCents,
      deliveryCents,
      totalUnits: [...unitsByProduct.values()].reduce((a, b) => a + b, 0),
      deductions: [...unitsByProduct].map(([productId, units]) => ({
        productId,
        units,
      })),
      variantDeductions,
      lines,
    };
  }

  /**
   * Combo checkout: every member is validated + decremented individually and
   * written as a full-price line (so cancel-restock and reporting keep
   * working), with one final negative "combo discount" line bringing the sum
   * down to the combo price, plus the delivery charge (one shipment - the
   * highest member fee for the buyer's zone).
   */
  private async buildComboCart(
    tx: OrdersTx,
    dto: CheckoutDto,
    _payKind: string | null,
  ): Promise<CheckoutCart> {
    const combo = await tx.query.combos.findFirst({
      where: and(eq(combos.id, dto.comboId!), eq(combos.shopId, dto.shopId)),
      with: { items: { with: { product: true } } },
    });
    if (!combo || !combo.active || combo.items.length < 2) {
      throw new NotFoundException('This combo offer is no longer available.');
    }

    // Combo sets ordered (the single-product/combo paths carry qty on the dto).
    const sets = dto.qty ?? 1;
    let membersValueCents = 0;
    let totalUnits = 0;
    const deductions: CheckoutCart['deductions'] = [];
    const lines: CheckoutCart['lines'] = [];
    for (const item of combo.items) {
      const product = item.product;
      if (
        product.listingType !== 'sale' ||
        (product.variantCombinations ?? []).length
      ) {
        throw new ConflictException('This combo offer is no longer available.');
      }
      const units = item.qty * sets;
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
        // Combo member lines are already written in units.
        units,
        unitPriceCents: product.priceCents,
        variant: `Combo: ${combo.name}`.slice(0, 240),
        variantPick: null,
      });
    }

    // One adjustment line reconciles the full-price member lines with the
    // combo price, so line totals always sum to the order total.
    const comboCents = combo.priceCents * sets;
    const adjustCents = comboCents - membersValueCents;
    if (adjustCents !== 0) {
      lines.push({
        productId: null,
        name: `Combo ${adjustCents < 0 ? 'discount' : 'adjustment'} - ${combo.name}`.slice(
          0,
          200,
        ),
        qty: 1,
        units: null,
        unitPriceCents: adjustCents,
        variant: null,
        variantPick: null,
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
      // A combo names whole products, never a variant choice, so there is no
      // per-option counter to move.
      variantDeductions: [],
      lines,
    };
  }

  /**
   * The zone delivery charge the storefront quoted: the product's Dhaka /
   * outside-Dhaka fee (a combo ships together - its highest member fee).
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
      name: DELIVERY_LINE_NAME,
      qty: 1,
      units: null,
      unitPriceCents: deliveryCents,
      variant: inDhaka ? 'Inside Dhaka' : 'Outside Dhaka',
      variantPick: null,
    });
  }

  /**
   * Paginated admin list. `total` counts the filtered set; `stats` are
   * shop-wide aggregates (one grouped query) so tab counts and KPI cards
   * stay correct regardless of the active page or filter. Orders whose
   * gateway payment is still in flight (pay = 'Pending') are hidden - they
   * only enter the pipeline once the gateway confirms the money.
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
        with: { items: true, adjustments: true },
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

    const accountIds = await this.orderIdsWithBuyerAccount(rows);

    return {
      data: rows.map((o) =>
        OrderResponse.fromRow(o, o.items, o.adjustments, accountIds.has(o.id)),
      ),
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
   * The public contract addresses orders by their human reference ("#1042" -
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
      with: { items: true, adjustments: true },
    });
    if (!order) {
      throw new NotFoundException('Order not found');
    }
    const hasAccount = await this.orderHasBuyerAccount(order);
    return OrderResponse.fromRow(
      order,
      order.items,
      order.adjustments,
      hasAccount,
    );
  }

  /**
   * Advance the pipeline one step, New→Confirmed→Packed→HandedOver.
   *
   * That is as far as a seller can take an order. 'Shipped' and 'Delivered'
   * belong to the courier - it is the one party here a shop cannot edit - and
   * arrive through `applyCourierEvent` or `refreshCourier`. Delivering a COD
   * order also collects its cash, so letting a seller declare a delivery would
   * let them declare the money too.
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
    if (!(await this.sellerMayAdvance(order))) {
      throw new ForbiddenException(
        `This parcel is with ${this.courierLabel(order.courierProvider)} now - it moves to ${next} when the courier reports it, not from here.`,
      );
    }
    if (next === 'HandedOver') {
      await this.assertHandoverAllowed(order);
    }
    // Only reachable on a manually-delivered order (no consignment, couriers
    // not mandatory) - a courier-booked one never gets this far by hand.
    const codCollected =
      next === 'Delivered' &&
      order.pay === 'Due' &&
      (await this.isCodOrder(order));
    const [row] = await this.db
      .update(orders)
      .set({
        status: next,
        ...(next === 'HandedOver' && { handedOverAt: new Date() }),
        ...(codCollected && { pay: 'Paid' as const }),
      })
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
   * so they are excluded - a seller cannot self-mark platform money as paid.
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
    if (order.advancePaidAt && order.status !== 'Delivered') {
      throw new ConflictException(
        'The remaining balance is due on delivery and cannot be confirmed yet.',
      );
    }
    const method = order.paymentMethod
      ? (await this.paymentMethods.byCode()).get(order.paymentMethod)
      : undefined;
    if (method && method.gateway !== 'none') {
      throw new ConflictException(
        'This order is collected by the payment gateway and confirms automatically.',
      );
    }
    // Protected COD has two receipts: the advance, then the balance. The first
    // confirmation records only the advance and intentionally leaves the
    // order Due for the cash collected at delivery.
    const confirmsAdvance = order.advanceCents > 0 && !order.advancePaidAt;
    const [row] = await this.db
      .update(orders)
      .set(
        confirmsAdvance
          ? { advancePaidAt: new Date() }
          : { pay: 'Paid' as const },
      )
      .where(eq(orders.id, order.id))
      .returning();
    await this.notifications.orderEvent(
      this.db,
      row,
      'payment_confirmed',
      `Payment received for order ${row.reference}`,
      confirmsAdvance
        ? 'The seller confirmed your advance payment. Pay the remaining balance when your order arrives.'
        : 'The seller confirmed your payment. Thank you!',
    );
    const items = await this.db.query.orderItems.findMany({
      where: eq(orderItems.orderId, order.id),
    });
    return OrderResponse.fromRow(row, items);
  }

  // ── Buyer-approved amount adjustments ────────────────────────

  /**
   * Seller changes an order total (with a reason). A **decrease** only benefits
   * the buyer, so it is auto-applied and the buyer is simply informed (a card in
   * the chat thread). An **increase** needs the buyer's consent: it stays pending
   * and posts an approval card the buyer acts on in chat (or their profile).
   *
   * Only on unpaid (Due) orders that haven't shipped and have no courier booked
   * - so no money has moved and the courier COD figure is still the order total.
   * At most one pending proposal at a time.
   *
   * The buyer must hold a *verified* account matching the order (verified email
   * now; verified phone once that exists): approval is an authenticated,
   * account-only action, so a guest order - or one matched only by an
   * unverified identifier - can't be adjusted (there'd be no owner to approve,
   * and no thread to notify). Such orders are blocked up front.
   */
  async requestAmountAdjustment(
    shopId: string,
    id: string,
    input: { newTotal: number; reason: string },
  ): Promise<OrderResponse> {
    const order = await this.requireOwned(shopId, id);
    const reason = input.reason.trim();
    if (!reason) {
      throw new BadRequestException('Add a short reason for the change.');
    }
    if (
      order.status === 'Cancelled' ||
      !AMOUNT_ADJUSTABLE.includes(order.status)
    ) {
      throw new BadRequestException(
        'This order can no longer be changed - amount changes are only possible before it ships.',
      );
    }
    if (order.pay !== 'Due') {
      throw new ConflictException(
        'Only unpaid (due) orders can have their amount changed for buyer approval.',
      );
    }
    if (order.advancePaidAt) {
      throw new ConflictException(
        'The amount cannot be changed after an advance payment has been received.',
      );
    }
    if (order.courierConsignmentId) {
      throw new ConflictException(
        'A courier is already booked - the amount is locked to the consignment.',
      );
    }
    if (!(await this.orderHasBuyerAccount(order))) {
      // Orders placed with only a phone carry a synthetic "<phone>@phone.local"
      // email - point the seller at the phone number in that case.
      const identifier = order.email.endsWith('@phone.local')
        ? 'phone number'
        : 'email';
      throw new BadRequestException(
        `This order isn't tied to a verified buyer account, so there's no owner to approve a change. It becomes available once the buyer verifies an account using this order's ${identifier}.`,
      );
    }
    const newTotalCents = dollarsToCents(input.newTotal);
    if (!Number.isFinite(newTotalCents) || newTotalCents <= 0) {
      throw new BadRequestException('Enter a valid new amount.');
    }
    if (newTotalCents === order.totalCents) {
      throw new BadRequestException(
        'The new amount is the same as the current total.',
      );
    }
    // The order total always includes delivery, so a change can't drop below it.
    if (newTotalCents < order.deliveryCents) {
      throw new BadRequestException(
        'The new amount cannot be less than the delivery charge.',
      );
    }

    const [existingPending] = await this.db
      .select({ id: orderAmountAdjustments.id })
      .from(orderAmountAdjustments)
      .where(
        and(
          eq(orderAmountAdjustments.orderId, order.id),
          eq(orderAmountAdjustments.status, 'pending'),
        ),
      );
    if (existingPending) {
      throw new ConflictException(
        'This order already has a change waiting for the buyer to approve.',
      );
    }

    const reasonText = reason.slice(0, 300);
    const previousTotalCents = order.totalCents;
    const accountId = await this.resolveOrderAccountId(order);

    if (newTotalCents < previousTotalCents) {
      // ── Decrease: auto-applied, no approval needed ──
      const adjustmentId = await this.db.transaction(async (tx) => {
        const [adj] = await tx
          .insert(orderAmountAdjustments)
          .values({
            orderId: order.id,
            shopId: order.shopId,
            previousTotalCents,
            newTotalCents,
            reason: reasonText,
            status: 'approved',
            resolvedAt: new Date(),
          })
          .returning({ id: orderAmountAdjustments.id });
        await tx
          .update(orders)
          .set({ totalCents: newTotalCents })
          .where(eq(orders.id, order.id));
        if (order.customerId) {
          await this.customers.adjustSpend(
            tx,
            order.customerId,
            newTotalCents - previousTotalCents,
          );
        }
        await this.notifications.orderEvent(
          tx,
          order,
          'order_adjustment',
          `Order ${order.reference} - total lowered`,
          `Good news - the shop lowered your order total to ${formatBdt(newTotalCents)} (${reasonText}).`,
        );
        return adj.id;
      });
      if (accountId) {
        await this.postAdjustmentCard(order, accountId, {
          adjustmentId,
          previousTotalCents,
          newTotalCents,
          reason: reasonText,
          status: 'approved',
        });
      }
    } else {
      // ── Increase: needs the buyer's approval ──
      const [adj] = await this.db
        .insert(orderAmountAdjustments)
        .values({
          orderId: order.id,
          shopId: order.shopId,
          previousTotalCents,
          newTotalCents,
          reason: reasonText,
        })
        .returning({ id: orderAmountAdjustments.id });
      await this.notifications.orderEvent(
        this.db,
        order,
        'order_adjustment',
        `Order ${order.reference} - approval needed`,
        `The seller updated your order total to ${formatBdt(newTotalCents)} (${reasonText}). Approve or decline it in chat or your profile.`,
      );
      if (accountId) {
        await this.postAdjustmentCard(order, accountId, {
          adjustmentId: adj.id,
          previousTotalCents,
          newTotalCents,
          reason: reasonText,
          status: 'pending',
        });
      }
    }

    return this.orderResponseWithHistory(order.id);
  }

  /** The verified account id that owns an order (or null), used to address the
   *  chat thread and confirm ownership - same match rule as the reprice gate. */
  private async resolveOrderAccountId(
    order: Pick<OrderRow, 'userId' | 'email' | 'phone'>,
  ): Promise<string | null> {
    // Placed while signed in, or claimed since - then there is nothing to
    // work out, and no chance of the contact details having moved on.
    if (order.userId) return order.userId;
    const phone = normalizePhone(order.phone);
    const email = order.email.toLowerCase();
    const candidates = await this.db.query.users.findMany({
      where: phone
        ? or(eq(users.email, email), eq(users.phone, phone))
        : eq(users.email, email),
      columns: {
        id: true,
        email: true,
        phone: true,
        emailVerified: true,
        phoneVerified: true,
      },
    });
    const match = candidates.find(
      (b) =>
        (b.emailVerified && b.email === email) ||
        (b.phoneVerified && !!phone && b.phone === phone),
    );
    return match?.id ?? null;
  }

  /** How many ordered lines the chat card shows before it says "+N more". */
  private static readonly ADJUST_CARD_LINES = 3;

  /**
   * Post the order-amount change card into the (buyer, shop) chat thread.
   *
   * The card carries a snapshot of the order it changes - the first few lines
   * with their photos, what shipping costs, when it was placed, how it is
   * being paid - so the buyer can tell what they are approving without leaving
   * the thread. Snapshotted, like every other card: a later catalogue edit
   * must not rewrite what the shop asked them to agree to.
   */
  private async postAdjustmentCard(
    order: OrderRow,
    accountId: string,
    a: {
      adjustmentId: string;
      previousTotalCents: number;
      newTotalCents: number;
      reason: string;
      status: 'pending' | 'approved';
    },
  ): Promise<void> {
    const [shop, lines, methods] = await Promise.all([
      this.db.query.shops.findFirst({
        where: eq(shops.id, order.shopId),
        columns: { currency: true },
      }),
      this.db.query.orderItems.findMany({
        where: eq(orderItems.orderId, order.id),
        with: {
          product: {
            columns: { slug: true, images: true, emoji: true, tone: true },
          },
        },
      }),
      this.paymentMethods.byCode(),
    ]);
    // Shipping and combo-reconciliation rows are not things the buyer bought.
    const bought = productLines(lines);
    const method = order.paymentMethod
      ? methods.get(order.paymentMethod)
      : undefined;

    await this.messages.postShopMessage(order.shopId, accountId, {
      type: 'adjustment',
      adjustment: {
        adjustmentId: a.adjustmentId,
        displayId: order.reference,
        previousTotal: centsToDollars(a.previousTotalCents),
        newTotal: centsToDollars(a.newTotalCents),
        reason: a.reason,
        currency: shop?.currency ?? 'BDT',
        direction:
          a.newTotalCents < a.previousTotalCents ? 'decrease' : 'increase',
        status: a.status,
        items: bought.slice(0, OrdersService.ADJUST_CARD_LINES).map((l) => ({
          name: l.name,
          qty: l.qty,
          variant: l.variant ?? undefined,
          lineTotal: centsToDollars(l.unitPriceCents * l.qty),
          imageUrl: l.product?.images?.[0],
          emoji: l.product?.emoji,
          tone: l.product?.tone,
          slug: l.product?.slug,
        })),
        moreItems: Math.max(0, bought.length - OrdersService.ADJUST_CARD_LINES),
        itemCount: bought.reduce((n, l) => n + l.qty, 0),
        delivery: centsToDollars(order.deliveryCents),
        placedAt: order.placedAt.toISOString(),
        orderStatus: order.status,
        paymentMethod: order.paymentMethod ?? undefined,
        paymentLabel: method?.title,
      },
    });
  }

  /** Seller withdraws their own still-pending amount proposal. */
  async withdrawAmountAdjustment(
    shopId: string,
    id: string,
    adjustmentId: string,
  ): Promise<OrderResponse> {
    const order = await this.requireOwned(shopId, id);
    const [row] = await this.db
      .update(orderAmountAdjustments)
      .set({ status: 'withdrawn', resolvedAt: new Date() })
      .where(
        and(
          eq(orderAmountAdjustments.id, adjustmentId),
          eq(orderAmountAdjustments.orderId, order.id),
          eq(orderAmountAdjustments.status, 'pending'),
        ),
      )
      .returning();
    if (!row) {
      throw new NotFoundException(
        'No pending amount change was found to withdraw.',
      );
    }
    // Reflect on the chat card so its buttons disappear, and tell the buyer.
    await this.messages.updateAdjustmentStatus(adjustmentId, 'withdrawn');
    const accountId = await this.resolveOrderAccountId(order);
    if (accountId) {
      await this.messages.postShopMessage(order.shopId, accountId, {
        type: 'text',
        text: `The amount change for order ${order.reference} was withdrawn by the shop.`,
      });
    }
    return this.orderResponseWithHistory(order.id);
  }

  /**
   * Buyer approves or declines a pending amount change from their profile.
   * Ownership is the order-email ↔ account match (same link the buyer's order
   * list uses). Runs in a transaction so the order total and the adjustment
   * status can't diverge.
   */
  async respondToAdjustmentByBuyer(
    buyerEmail: string,
    shopId: string,
    reference: string,
    adjustmentId: string,
    approve: boolean,
  ): Promise<OrderResponse> {
    const result = await this.db.transaction(async (tx) => {
      const order = await tx.query.orders.findFirst({
        where: and(eq(orders.shopId, shopId), eq(orders.reference, reference)),
      });
      // A foreign/missing order is reported identically so the endpoint can't
      // be used to probe other buyers' orders.
      if (!order || order.email.toLowerCase() !== buyerEmail.toLowerCase()) {
        throw new NotFoundException('Order not found');
      }
      const adjustment = await tx.query.orderAmountAdjustments.findFirst({
        where: and(
          eq(orderAmountAdjustments.id, adjustmentId),
          eq(orderAmountAdjustments.orderId, order.id),
        ),
      });
      if (!adjustment || adjustment.status !== 'pending') {
        throw new ConflictException(
          'This amount change is no longer awaiting your approval.',
        );
      }

      const row = await this.applyAdjustmentDecision(
        tx,
        order,
        adjustment,
        approve,
      );

      const [items, adjustments] = await Promise.all([
        tx.query.orderItems.findMany({
          where: eq(orderItems.orderId, order.id),
        }),
        tx.query.orderAmountAdjustments.findMany({
          where: eq(orderAmountAdjustments.orderId, order.id),
        }),
      ]);
      return {
        response: OrderResponse.fromRow(row, items, adjustments),
        order: row,
        newTotalCents: adjustment.newTotalCents,
      };
    });

    // Post-commit: reflect the outcome on the chat card and add a history line.
    await this.messages.updateAdjustmentStatus(
      adjustmentId,
      approve ? 'approved' : 'rejected',
    );
    const accountId = await this.resolveOrderAccountId(result.order);
    if (accountId) {
      await this.messages.postShopMessage(shopId, accountId, {
        type: 'text',
        text: approve
          ? `Order ${reference} total updated to ${formatBdt(result.newTotalCents)}.`
          : `The amount change for order ${reference} was declined - total stays ${formatBdt(result.order.totalCents)}.`,
      });
    }
    return result.response;
  }

  /**
   * Shared approve/decline core for the buyer path. Marks the adjustment
   * resolved; on approval rewrites the order total (guarding that it hasn't
   * moved since the request) and re-syncs the customer's lifetime spend by the
   * delta. Emits a buyer notification. Returns the possibly-updated order row.
   */
  private async applyAdjustmentDecision(
    tx: OrdersTx,
    order: OrderRow,
    adjustment: {
      id: string;
      previousTotalCents: number;
      newTotalCents: number;
    },
    approve: boolean,
  ): Promise<OrderRow> {
    await tx
      .update(orderAmountAdjustments)
      .set({
        status: approve ? 'approved' : 'rejected',
        resolvedAt: new Date(),
      })
      .where(eq(orderAmountAdjustments.id, adjustment.id));

    let row = order;
    if (approve) {
      // Guard against the total having moved since the proposal was made
      // (another adjustment, a refund, …): only apply from the quoted total.
      if (order.totalCents !== adjustment.previousTotalCents) {
        throw new ConflictException(
          'The order total changed since this request - please ask the seller to send it again.',
        );
      }
      [row] = await tx
        .update(orders)
        .set({ totalCents: adjustment.newTotalCents })
        .where(eq(orders.id, order.id))
        .returning();
      if (order.customerId) {
        await this.customers.adjustSpend(
          tx,
          order.customerId,
          adjustment.newTotalCents - adjustment.previousTotalCents,
        );
      }
    }

    await this.notifications.orderEvent(
      tx,
      row,
      'order_adjustment',
      `Order ${row.reference} - amount ${approve ? 'approved' : 'declined'}`,
      approve
        ? `You approved the updated total of ${formatBdt(adjustment.newTotalCents)}.`
        : `You declined the seller's updated total. Your order total stays ${formatBdt(order.totalCents)}.`,
    );
    return row;
  }

  /** Reload an order as a full OrderResponse (items + amount history). */
  private async orderResponseWithHistory(
    orderId: string,
  ): Promise<OrderResponse> {
    const order = await this.db.query.orders.findFirst({
      where: eq(orders.id, orderId),
      with: { items: true, adjustments: true },
    });
    if (!order) {
      throw new NotFoundException('Order not found');
    }
    const hasAccount = await this.orderHasBuyerAccount(order);
    return OrderResponse.fromRow(
      order,
      order.items,
      order.adjustments,
      hasAccount,
    );
  }

  /**
   * Does this order belong to a buyer who has *verified* the matching
   * identifier? Only a verified email (or, once it exists, a verified phone)
   * counts - a guest order attaches to an account only after the owner proves
   * they own the email/phone it was placed with. This gates repricing so a
   * change can only be approved by the real order owner.
   */
  private async orderHasBuyerAccount(
    order: Pick<OrderRow, 'email' | 'phone'>,
  ): Promise<boolean> {
    const phone = normalizePhone(order.phone);
    const email = order.email.toLowerCase();
    const candidates = await this.db.query.users.findMany({
      where: phone
        ? or(eq(users.email, email), eq(users.phone, phone))
        : eq(users.email, email),
      columns: {
        email: true,
        phone: true,
        emailVerified: true,
        phoneVerified: true,
      },
    });
    return candidates.some(
      (b) =>
        (b.emailVerified && b.email === email) ||
        (b.phoneVerified && !!phone && b.phone === phone),
    );
  }

  /**
   * Batch version of {@link orderHasBuyerAccount} for the list page: one query
   * resolves which of the given orders belong to a verified account. Returns
   * the set of order ids that do.
   */
  private async orderIdsWithBuyerAccount(
    rows: Pick<OrderRow, 'id' | 'email' | 'phone'>[],
  ): Promise<Set<string>> {
    const emails = [
      ...new Set(rows.map((r) => r.email.toLowerCase()).filter(Boolean)),
    ];
    const phones = [
      ...new Set(rows.map((r) => normalizePhone(r.phone)).filter(Boolean)),
    ];
    if (!emails.length && !phones.length) return new Set();
    const accounts = await this.db.query.users.findMany({
      where: or(
        emails.length ? inArray(users.email, emails) : undefined,
        phones.length ? inArray(users.phone, phones) : undefined,
      ),
      columns: {
        email: true,
        phone: true,
        emailVerified: true,
        phoneVerified: true,
      },
    });
    // Only verified identifiers attach an order to an account.
    const verifiedEmails = new Set(
      accounts.filter((a) => a.emailVerified && a.email).map((a) => a.email),
    );
    const verifiedPhones = new Set(
      accounts.filter((a) => a.phoneVerified && a.phone).map((a) => a.phone),
    );
    const out = new Set<string>();
    for (const r of rows) {
      const phone = normalizePhone(r.phone);
      if (
        verifiedEmails.has(r.email.toLowerCase()) ||
        (phone && verifiedPhones.has(phone))
      ) {
        out.add(r.id);
      }
    }
    return out;
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
      // A refunded order was already unwound from the customer's spend -
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
   * One of the buyer's own orders in full - what the profile's order drawer
   * renders. The list payload stays deliberately thin (no product media across
   * every order the account ever placed), so the whole picture is fetched one
   * order at a time, when it is actually opened.
   *
   * Ownership is the same order-email ↔ account match the list is built on,
   * and a foreign order is reported exactly like a missing one so references
   * can't be probed.
   */
  async orderDetailForBuyer(
    buyerEmail: string,
    shopId: string,
    reference: string,
  ): Promise<BuyerOrderDetailResponse> {
    const order = await this.db.query.orders.findFirst({
      where: and(eq(orders.shopId, shopId), eq(orders.reference, reference)),
      with: {
        shop: { columns: { name: true, handle: true } },
        adjustments: true,
        items: {
          with: {
            product: {
              columns: { slug: true, images: true, emoji: true, tone: true },
            },
          },
        },
      },
    });
    if (!order || order.email.toLowerCase() !== buyerEmail.toLowerCase()) {
      throw new NotFoundException('Order not found');
    }
    const methods = await this.paymentMethods.byCode();
    const method = order.paymentMethod
      ? methods.get(order.paymentMethod)
      : undefined;

    const items = order.items.map((l) => ({
      name: l.name,
      qty: l.qty,
      variant: l.variant ?? undefined,
      unitPrice: centsToDollars(l.unitPriceCents),
      lineTotal: centsToDollars(l.unitPriceCents * l.qty),
      kind: orderLineKind(l),
      imageUrl: l.product?.images?.[0],
      emoji: l.product?.emoji,
      tone: l.product?.tone,
      slug: l.product?.slug,
    }));
    const bought = items.filter((l) => l.kind === 'product');

    return {
      reference: order.reference,
      shopId: order.shopId,
      shopName: order.shop?.name ?? 'Shop',
      shopHandle: order.shop?.handle ?? '',
      status: order.status,
      pay: order.pay,
      placedAt: order.placedAt.toISOString(),
      paymentMethod: order.paymentMethod ?? undefined,
      paymentLabel: method?.title,
      items,
      qty: bought.reduce((n, l) => n + l.qty, 0),
      itemsSubtotal: bought.reduce((s, l) => s + l.lineTotal, 0),
      delivery: centsToDollars(order.deliveryCents),
      discount: centsToDollars(order.discountCents),
      couponCode: order.couponCode ?? undefined,
      total: centsToDollars(order.totalCents),
      address: order.address ?? undefined,
      courierProvider:
        order.courierProvider ??
        (order.courierConsignmentId ? 'steadfast' : undefined),
      courierTrackingCode: order.courierTrackingCode ?? undefined,
      courierStatus: order.courierStatus ?? undefined,
      courierStatusAt: order.courierStatusAt?.toISOString(),
      adjustments: [...order.adjustments]
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((a) => ({
          id: a.id,
          previousTotal: centsToDollars(a.previousTotalCents),
          newTotal: centsToDollars(a.newTotalCents),
          reason: a.reason,
          status: a.status,
          createdAt: a.createdAt.toISOString(),
          resolvedAt: a.resolvedAt?.toISOString(),
        })),
      canCancel:
        BUYER_CANCELLABLE.includes(order.status) && order.pay !== 'Paid',
    };
  }

  /**
   * Buyer self-service cancel - only while the order is still 'New' (the shop
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
      if (!order || order.email.toLowerCase() !== buyerEmail.toLowerCase()) {
        throw new NotFoundException('Order not found');
      }
      if (order.status === 'Cancelled') {
        throw new ConflictException('This order is already cancelled.');
      }
      if (!BUYER_CANCELLABLE.includes(order.status) || order.pay === 'Paid') {
        throw new BadRequestException(
          'The shop has already started processing this order - please contact the shop to cancel it.',
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
    const returns: VariantDeduction[] = [];
    for (const item of items) {
      if (!item.productId) continue;
      // Give back what the line actually took: `units` for anything placed
      // since that column existed, `qty` for older rows - which is also all
      // those orders ever had deducted for non-pack lines.
      const units = item.units ?? item.qty;
      // On a product that still sells exact rows this increment is overwritten
      // a few lines down, where the aggregate is recomputed from those rows -
      // so it neither double-counts nor invents stock for a row the seller has
      // since deleted. It only survives when the product has left the exact
      // model entirely, which is precisely when it is the right place to land.
      await tx
        .update(products)
        .set({ stock: sql`${products.stock} + ${units}` })
        .where(eq(products.id, item.productId));
      // Lines placed before per-option stock existed have no pick recorded;
      // those only ever moved the product-level counter, so there is nothing
      // else to give back.
      if (item.variantPick && Object.keys(item.variantPick).length) {
        returns.push({
          productId: item.productId,
          variantPick: item.variantPick,
          combinationId: item.variantCombinationId,
          units,
        });
      }
    }
    // Options the seller has stopped tracking since the order are skipped by
    // applyVariantStock rather than resurrected with a count.
    await this.applyVariantStock(tx, returns, 1);
    // Hand the coupon use back - a cancelled order shouldn't burn the buyer's
    // one redemption, nor a slot from a capped code.
    await this.shopCoupons.releaseForOrder(tx, order.id);

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
   * Void an order whose gateway payment never completed (the gateway refused
   * to open one, the buyer cancelled on the hosted page, or it expired).
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
    const order = await this.db.query.orders.findFirst({
      where: eq(orders.id, orderId),
    });
    if (!order || order.pay !== 'Pending') return null;
    const isAdvance = order.advanceCents > 0;
    const [row] = await this.db
      .update(orders)
      .set(
        isAdvance
          ? { pay: 'Due' as const, advancePaidAt: new Date() }
          : { pay: 'Paid' as const },
      )
      .where(and(eq(orders.id, orderId), eq(orders.pay, 'Pending')))
      .returning();
    if (row) {
      await this.notifications.orderEvent(
        this.db,
        row,
        'payment_confirmed',
        `Order ${row.reference} confirmed`,
        isAdvance
          ? 'Your 15% advance was received. Pay the remaining balance when your order arrives.'
          : 'Your payment was received and your order is now with the seller.',
      );
    }
    return row ?? null;
  }

  // ── Courier (platform account: CarryBee / Steadfast / Pathao) ──
  //
  // Every parcel is booked on the operator's own courier credentials. That is
  // deliberate: the courier is the one party in the chain a shop cannot edit,
  // so its consignment - not the seller's word - decides when an order ships,
  // is delivered, or comes back.

  /** Display name for a provider code, for messages the seller reads. */
  private courierLabel(provider: string | null): string {
    return provider === 'carrybee'
      ? 'CarryBee'
      : provider === 'pathao'
        ? 'Pathao'
        : provider === 'steadfast'
          ? 'Steadfast'
          : 'the courier';
  }

  /**
   * Whether the seller may still advance this order by hand.
   *
   * Up to 'HandedOver' they always may. Past it the courier owns the order -
   * unless no courier is behind it at all and the platform doesn't insist on
   * one, in which case the seller is the only party who can move it and
   * manual fulfilment stays open to them.
   */
  private async sellerMayAdvance(order: OrderRow): Promise<boolean> {
    if (SELLER_ADVANCEABLE.includes(order.status)) return true;
    if (order.courierConsignmentId) return false;
    return !(await this.courierSettings.courierRequired());
  }

  /**
   * Handover is the seller declaring the parcel has physically left. When the
   * platform requires its courier, that declaration has to be backed by a
   * consignment - otherwise "handed over" is just a word, and the order could
   * walk to Delivered with nothing verifiable behind it.
   */
  private async assertHandoverAllowed(order: OrderRow): Promise<void> {
    if (order.advanceCents > 0 && !order.advancePaidAt) {
      throw new BadRequestException(
        'Confirm the 15% advance payment before handing over this order.',
      );
    }
    if (order.courierConsignmentId) return;
    if (!(await this.courierSettings.courierRequired())) return;
    throw new BadRequestException(
      'Book the parcel with the courier before marking it handed over.',
    );
  }

  /**
   * Book a parcel for a confirmed/packed order on the platform's courier
   * account. The courier collects the order total in cash when the money is
   * still due (COD), nothing when it was prepaid.
   *
   * CarryBee and Pathao need the recipient's city/zone as their own numeric
   * ids; CarryBee can usually derive them from the written address, and the
   * booking modal supplies them when it can't.
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
    if (order.advanceCents > 0 && !order.advancePaidAt) {
      throw new BadRequestException(
        'Confirm the 15% advance payment before booking a courier.',
      );
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
    const active = await this.courierSettings.activeCourier();
    if (!active) {
      throw new BadRequestException(
        'No courier is set up on the platform yet - the operator configures it in the platform console.',
      );
    }
    const shipment = {
      invoice: `${order.reference.replace('#', '')}-${order.id.slice(0, 8)}`,
      recipientName: order.customerName,
      recipientPhone: order.phone,
      recipientAddress: address,
      codAmountCents:
        order.pay === 'Due' ? order.totalCents - order.advanceCents : 0,
      note: `Order ${order.reference}`,
    };
    let booked: {
      consignmentId: string;
      trackingCode: string | null;
      status: string;
      deliveryFeeCents: number | null;
      codFeeCents: number | null;
    };
    if (active.provider === 'carrybee') {
      // The seller's picks win; otherwise let CarryBee read the address it
      // was given, and only ask when it can't make sense of it.
      const place =
        opts?.cityId && opts.zoneId
          ? { cityId: opts.cityId, zoneId: opts.zoneId }
          : await this.carrybee.resolveAddress(active.config, address);
      if (!place) {
        throw new BadRequestException(
          'Pick the delivery city and zone to book with CarryBee.',
        );
      }
      // Collected from this shop's own address, not a platform-wide one -
      // registered with the courier on the first booking a shop makes.
      const storeId = await this.courierStores.resolve(
        shopId,
        'carrybee',
        active.config,
      );
      const c = await this.carrybee.createOrder(active.config, {
        ...shipment,
        storeId,
        merchantOrderId: shipment.invoice,
        cityId: place.cityId,
        zoneId: place.zoneId,
        areaId: opts?.areaId,
        itemQuantity: order.qty,
        description: `Order ${order.reference}`,
      });
      // CarryBee has no separate tracking code - the consignment ID is it.
      booked = {
        consignmentId: c.consignmentId,
        trackingCode: c.consignmentId,
        status: 'created',
        deliveryFeeCents: c.deliveryFeeCents,
        codFeeCents: c.codFeeCents,
      };
    } else if (active.provider === 'steadfast') {
      const c = await this.steadfast.createConsignment(active.config, shipment);
      booked = {
        consignmentId: c.consignmentId,
        trackingCode: c.trackingCode,
        status: c.status,
        deliveryFeeCents: null,
        codFeeCents: null,
      };
    } else {
      if (!opts?.cityId || !opts.zoneId) {
        throw new BadRequestException(
          'Pick the delivery city and zone to book with Pathao.',
        );
      }
      const storeId = await this.courierStores.resolve(
        shopId,
        'pathao',
        active.config,
      );
      const c = await this.pathao.createOrder(active.config, {
        ...shipment,
        storeId,
        cityId: opts.cityId,
        zoneId: opts.zoneId,
        areaId: opts.areaId,
        itemQuantity: order.qty,
      });
      // Pathao has no separate tracking code either.
      booked = {
        consignmentId: c.consignmentId,
        trackingCode: c.consignmentId,
        status: c.status,
        deliveryFeeCents: c.deliveryFeeCents,
        codFeeCents: null,
      };
    }
    const [row] = await this.db
      .update(orders)
      .set({
        courierProvider: active.provider,
        courierConsignmentId: booked.consignmentId,
        courierTrackingCode: booked.trackingCode,
        courierStatus: booked.status,
        courierStatusAt: new Date(),
        courierDeliveryFeeCents: booked.deliveryFeeCents,
        courierCodFeeCents: booked.codFeeCents,
      })
      .where(eq(orders.id, order.id))
      .returning();
    const items = await this.db.query.orderItems.findMany({
      where: eq(orderItems.orderId, order.id),
    });
    return OrderResponse.fromRow(row, items);
  }

  /**
   * Pull the consignment's current state from its provider. This is the
   * reconciliation path for the webhook - a missed or late delivery event
   * lands here instead - so it funnels into exactly the same effects.
   */
  async refreshCourier(shopId: string, id: string): Promise<OrderResponse> {
    const order = await this.requireOwned(shopId, id);
    if (!order.courierConsignmentId) {
      throw new NotFoundException('No courier is booked for this order.');
    }
    const observed = await this.readCourierState(order);
    let row = order;
    if (observed) {
      row =
        (await this.applyCourierEffect(order.id, observed)) ??
        (await this.requireOwned(shopId, id));
    }
    const items = await this.db.query.orderItems.findMany({
      where: eq(orderItems.orderId, order.id),
    });
    return OrderResponse.fromRow(row, items);
  }

  /**
   * Write a courier callback down, then act on it.
   *
   * The order of those two is the point. The courier decides whether an order
   * shipped, was delivered, and whether its COD cash came in, so an event lost
   * to a transient failure is money - and one handled inline left no record of
   * what was missed. Recording first means the worst case is a delay the sweep
   * closes, not a hole nobody can see.
   *
   * Never throws: the route has already promised CarryBee a 202, and a
   * recorded-but-unprocessed row is exactly what the sweep is for.
   */
  async recordCourierEvent(body: CarrybeeWebhookBody): Promise<void> {
    const at = body.timestamptz ? new Date(body.timestamptz) : null;
    let logged: CourierWebhookEventRow | undefined;
    try {
      [logged] = await this.db
        .insert(courierWebhookEvents)
        .values({
          provider: 'carrybee',
          event: (body.event ?? 'unknown').slice(0, 60),
          consignmentId: body.consignment_id?.trim().slice(0, 64) ?? null,
          merchantOrderId: body.merchant_order_id?.trim().slice(0, 64) ?? null,
          payload: body,
          eventAt: at && !Number.isNaN(at.getTime()) ? at : null,
        })
        .returning();
    } catch (err) {
      // Nothing left to fall back on, so this one really is lost - say so
      // loudly rather than letting it look handled.
      this.logger.error('Could not record a CarryBee webhook', err as Error);
      return;
    }
    await this.processCourierEvent(logged);
  }

  /**
   * Run one logged callback against its order and mark the row either done or
   * failed. "Done" includes events we knowingly do nothing with - an unknown
   * event name, or a consignment that is not ours - because retrying those
   * forever would bury the ones that are genuinely stuck.
   */
  private async processCourierEvent(
    row: CourierWebhookEventRow,
  ): Promise<void> {
    try {
      const orderId = await this.applyCourierEvent(
        row.payload as CarrybeeWebhookBody,
      );
      await this.db
        .update(courierWebhookEvents)
        .set({
          processedAt: new Date(),
          attempts: row.attempts + 1,
          lastError: null,
          ...(orderId && { orderId }),
        })
        .where(eq(courierWebhookEvents.id, row.id));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.db
        .update(courierWebhookEvents)
        .set({ attempts: row.attempts + 1, lastError: message.slice(0, 500) })
        .where(eq(courierWebhookEvents.id, row.id));
      this.logger.error(
        `CarryBee event ${row.event} (${row.consignmentId ?? '?'}) failed, attempt ${row.attempts + 1}: ${message}`,
      );
    }
  }

  /**
   * Retry callbacks that haven't been processed yet. This is what makes the
   * log a queue - and why a broker would be a third moving part solving a
   * problem one table already solves at this volume.
   *
   * Rows past MAX_WEBHOOK_ATTEMPTS are left alone: something is wrong that
   * retrying will not fix, and they stay in the table as the record of it.
   */
  private async sweepCourierWebhooks(): Promise<void> {
    try {
      const pending = await this.db.query.courierWebhookEvents.findMany({
        where: and(
          isNull(courierWebhookEvents.processedAt),
          lt(courierWebhookEvents.attempts, MAX_WEBHOOK_ATTEMPTS),
        ),
        orderBy: [asc(courierWebhookEvents.receivedAt)],
        limit: WEBHOOK_SWEEP_BATCH,
      });
      for (const row of pending) {
        await this.processCourierEvent(row);
      }
    } catch (err) {
      this.logger.error('CarryBee webhook sweep failed', err as Error);
    }
  }

  /**
   * Apply one CarryBee webhook event to the order behind its consignment.
   * Returns the order id it moved, or null when there was nothing to move (a
   * parcel booked outside the platform, an order since purged, or an event
   * CarryBee has added since this was written - guessing at what a new one
   * means for an order is worse than ignoring it).
   */
  async applyCourierEvent(body: CarrybeeWebhookBody): Promise<string | null> {
    const consignmentId = body.consignment_id?.trim();
    if (!consignmentId || !body.event) return null;
    const rule = CARRYBEE_EVENTS[body.event];
    if (!rule) return null;
    const order = await this.db.query.orders.findFirst({
      where: eq(orders.courierConsignmentId, consignmentId),
    });
    if (!order) return null;
    const at = body.timestamptz ? new Date(body.timestamptz) : new Date();
    await this.applyCourierEffect(order.id, {
      status: rule.status,
      effect: rule.effect,
      at: Number.isNaN(at.getTime()) ? new Date() : at,
      collectedCents: takaFieldToCents(body.collected_amount),
      deliveryFeeCents: takaFieldToCents(body.delivery_fee),
      codFeeCents: takaFieldToCents(body.cod_fee),
      reason: [body.reason, body.remarks].filter(Boolean).join(' - ') || null,
    });
    return order.id;
  }

  /**
   * The single place a courier observation changes an order.
   *
   * Runs in a transaction and re-reads the order under it, so a webhook and a
   * manual refresh landing together can't both act on the same stale row.
   * Returns the updated row, or null when the observation was ignored.
   */
  private async applyCourierEffect(
    orderId: string,
    observed: {
      status: string;
      effect: CourierEffect;
      at: Date;
      collectedCents?: number | null;
      deliveryFeeCents?: number | null;
      codFeeCents?: number | null;
      reason?: string | null;
    },
  ): Promise<OrderRow | null> {
    return this.db.transaction(async (tx) => {
      const order = await tx.query.orders.findFirst({
        where: eq(orders.id, orderId),
      });
      if (!order) return null;
      // Webhooks can arrive out of order and a refresh can race one. An
      // observation older than what's stored would roll the order backwards,
      // so it's dropped - the newer state is already the truth.
      if (order.courierStatusAt && order.courierStatusAt > observed.at) {
        return null;
      }
      const nothingNew =
        order.courierStatus === observed.status &&
        observed.effect !== 'delivered' &&
        observed.effect !== 'returned';
      if (nothingNew) return null;

      const courierPatch = {
        courierStatus: observed.status,
        courierStatusAt: observed.at,
        ...(observed.collectedCents != null && {
          courierCollectedCents: observed.collectedCents,
        }),
        ...(observed.deliveryFeeCents != null && {
          courierDeliveryFeeCents: observed.deliveryFeeCents,
        }),
        ...(observed.codFeeCents != null && {
          courierCodFeeCents: observed.codFeeCents,
        }),
        ...(observed.reason != null && {
          courierFailureReason: observed.reason.slice(0, 255),
        }),
      };
      // Terminal orders keep their badge updated but never move again.
      const terminal =
        order.status === 'Cancelled' || order.status === 'Delivered';

      if (observed.effect === 'returned' && !terminal) {
        // The parcel is physically back: restock it, release the coupon and
        // unwind the customer's totals, exactly as a seller-side cancel does.
        // A returned order is not a sale, and the sales meter agrees.
        await tx
          .update(orders)
          .set(courierPatch)
          .where(eq(orders.id, order.id));
        const row = await this.cancelTx(tx, { ...order, ...courierPatch });
        await this.notifications.orderEvent(
          tx,
          row,
          'order_cancelled',
          `Order ${row.reference} returned`,
          'This order came back to the seller and has been cancelled.',
        );
        return row;
      }

      let nextStatus: OrderStatus | null = null;
      if (!terminal) {
        if (observed.effect === 'delivered') nextStatus = 'Delivered';
        else if (observed.effect === 'shipped' && order.status !== 'Shipped') {
          nextStatus = 'Shipped';
        }
      }
      // Delivery collects the cash on a COD order - which is precisely why a
      // seller can't declare one.
      const codCollected =
        nextStatus === 'Delivered' &&
        order.pay === 'Due' &&
        (await this.isCodOrder(order));

      const [row] = await tx
        .update(orders)
        .set({
          ...courierPatch,
          ...(nextStatus && { status: nextStatus }),
          ...(nextStatus === 'Shipped' &&
            !order.handedOverAt && { handedOverAt: observed.at }),
          ...(codCollected && { pay: 'Paid' as const }),
        })
        .where(eq(orders.id, order.id))
        .returning();

      const copy = nextStatus ? STATUS_NOTIFICATION[nextStatus] : null;
      if (copy) {
        await this.notifications.orderEvent(
          tx,
          row,
          'order_status',
          `Order ${row.reference} ${nextStatus!.toLowerCase()}`,
          `Your order ${copy}.`,
        );
      }
      return row;
    });
  }

  /**
   * Ask the provider that booked this consignment where it is now, in the
   * shape `applyCourierEffect` consumes. Legacy rows booked before the
   * provider was recorded were all Steadfast.
   */
  private async readCourierState(order: OrderRow): Promise<{
    status: string;
    effect: CourierEffect;
    at: Date;
    collectedCents?: number | null;
    deliveryFeeCents?: number | null;
    codFeeCents?: number | null;
    reason?: string | null;
  } | null> {
    const consignmentId = order.courierConsignmentId!;
    if (order.courierProvider === 'carrybee') {
      const config = await this.courierSettings.carrybeeConfig();
      if (!config) {
        throw new BadRequestException(
          'CarryBee credentials are missing - the operator needs to restore them in the platform console to track this parcel.',
        );
      }
      const details = await this.carrybee.details(config, consignmentId);
      if (!details?.status) return null;
      return {
        status: details.status,
        effect: CARRYBEE_STATUS_EFFECTS[details.status] ?? 'none',
        at: details.updatedAt ?? new Date(),
        collectedCents: details.collectedCents,
        deliveryFeeCents: details.deliveryFeeCents,
        codFeeCents: details.codFeeCents,
        reason: details.reason,
      };
    }
    if (order.courierProvider === 'pathao') {
      const config = await this.courierSettings.pathaoConfig();
      if (!config) {
        throw new BadRequestException(
          'Pathao credentials are missing - the operator needs to restore them in the platform console to track this parcel.',
        );
      }
      const status = await this.pathao.status(config, consignmentId);
      return status
        ? { status, effect: legacyEffect(status), at: new Date() }
        : null;
    }
    const config = await this.courierSettings.steadfastConfig();
    if (!config) {
      throw new BadRequestException(
        'Steadfast credentials are missing - the operator needs to restore them in the platform console to track this parcel.',
      );
    }
    const status = await this.steadfast.status(config, consignmentId);
    return status
      ? { status, effect: legacyEffect(status), at: new Date() }
      : null;
  }

  private async isCodOrder(order: OrderRow): Promise<boolean> {
    if (order.advanceCents > 0) return true;
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

/**
 * Money on a CarryBee webhook arrives in Taka, as either a number or a string.
 * An absent field means "unchanged", not zero, so it stays null.
 */
function takaFieldToCents(
  raw: number | string | undefined | null,
): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const value = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(value) ? Math.round(value * 100) : null;
}

/**
 * Effect of a raw Steadfast/Pathao status string. Both report a flat status
 * rather than a lifecycle, so only the terminal ones mean anything - which is
 * all the pre-CarryBee code ever acted on.
 */
function legacyEffect(status: string): CourierEffect {
  if (status === 'delivered' || status === 'partial_delivered') {
    return 'delivered';
  }
  if (status === 'cancelled' || status === 'returned') return 'returned';
  return 'none';
}
