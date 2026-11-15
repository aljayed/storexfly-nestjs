import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from 'drizzle-orm';
import {
  SERVICE_FEE_BP,
  SERVICE_FEE_DUE_LIMIT_CENTS,
  SERVICE_FEE_GRACE_MS,
  salesFeeBp,
} from '../../common/constants/billing';
import { centsToDollars } from '../../common/utils/money.util';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import {
  orders,
  serviceFeePayments,
  shops,
  users,
} from '../../database/schema';
import type {
  GatewayPaymentRow,
  ServiceFeePaymentRow,
} from '../../database/schema';
import {
  GatewayCheckoutService,
  type CollectingGateway,
} from '../gateways/gateway-checkout.service';
import { MailService } from '../mail/mail.service';
import { PaymentMethodsService } from '../settlements/payment-methods.service';
import {
  allocate,
  isOverLimit,
  orderDue,
  payByOf,
  standingOf,
  type FeeOrder,
  type FeeStanding,
  type MethodCatalog,
  type OrderDue,
} from './service-fee-core';
import {
  FEE_COLUMNS,
  owingOrders,
  serviceFeeBalanceCents,
} from './service-fee-balance';
import type {
  PlatformServiceFeeRowResponse,
  PlatformServiceFeesResponse,
  ServiceFeeOrderResponse,
  ServiceFeePaymentResponse,
  ServiceFeeStatementResponse,
  ServiceFeeSummaryResponse,
} from './service-fees.dto';

/** How often shops are checked against the limit while nobody is looking. */
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/**
 * The least a gateway session is opened for, in paisa. A balance smaller
 * than this is still payable - the session is opened for this much and the
 * difference stays on the shop as credit against its next fees - so a
 * suspended shop is never stuck owing an amount too small to pay.
 */
const MIN_GATEWAY_CENTS = 1_000;

/** Settled orders shown beneath the unpaid ones on a statement. */
const STATEMENT_HISTORY = 60;

interface DueRow extends FeeOrder {
  reference: string;
  customerName: string;
  placedAt: Date;
  deliveredAt: Date | null;
  handedOverAt: Date | null;
  due: OrderDue;
}

/** Where one shop stands, as read (and corrected) inside a transaction. */
interface Position {
  feePercent: number;
  shopId: string;
  rows: DueRow[];
  balanceCents: number;
  overSince: Date | null;
  suspended: boolean;
  standing: FeeStanding;
}

/**
 * The service fee on money a seller collected themself.
 *
 * Paid online, an order's fee comes off the payout and never reaches here.
 * Collected in cash - or by direct transfer, or by any courier of the
 * seller's own - the platform holds nothing to deduct from, so the fee is
 * owed afterwards, together with the reseller's margin when the order was a
 * reseller's.
 *
 * Nothing here stores what is owed. It is read off the orders every time:
 * each delivered, paid order the seller collected owes its fee, and the
 * balance is that total less what the shop has paid in. A cancellation, a
 * refund or a stepped-back status therefore corrects the balance by itself,
 * and money already paid against an order that later falls away simply
 * becomes credit towards the next ones.
 *
 * Two things *are* written, because they are decisions rather than sums:
 *
 *   - `orders.duesPaidAt`, when payments reach an order. A reseller is paid
 *     their margin from that moment and not before.
 *   - `shops.duesOverSince`, when the balance goes over the limit. That
 *     starts the days the shop has to pay; when they run out it is
 *     suspended, and it returns the moment the balance is cleared.
 */
@Injectable()
export class ServiceFeesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ServiceFeesService.name);
  private sweepTimer?: NodeJS.Timeout;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly methods: PaymentMethodsService,
    private readonly gatewayCheckout: GatewayCheckoutService,
    private readonly mail: MailService,
  ) {}

  onModuleInit(): void {
    this.sweepTimer = setInterval(() => {
      void this.sweep();
    }, SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
    void this.sweep();
  }

  onModuleDestroy(): void {
    clearInterval(this.sweepTimer);
  }

  /* ── Seller console ────────────────────────────────────────────── */

  /** The few numbers the console shell needs to decide on a banner. */
  async summaryFor(shopId: string): Promise<ServiceFeeSummaryResponse> {
    return summaryOf(await this.reconcile(shopId));
  }

  /** The full statement: what is owed, order by order, and what was paid. */
  async statementFor(shopId: string): Promise<ServiceFeeStatementResponse> {
    const position = await this.reconcile(shopId);
    const [payments, gateways, resellerNames] = await Promise.all([
      this.db.query.serviceFeePayments.findMany({
        where: eq(serviceFeePayments.shopId, shopId),
        orderBy: [desc(serviceFeePayments.paidAt)],
        limit: 100,
      }),
      this.gatewayCheckout.available(),
      this.shopNames(position.rows.map((r) => r.resellerShopId)),
    ]);
    const unpaid = position.rows.filter((r) => !r.duesPaidAt);
    const settled = position.rows
      .filter((r) => r.duesPaidAt)
      .sort((a, b) => b.duesPaidAt!.getTime() - a.duesPaidAt!.getTime())
      .slice(0, STATEMENT_HISTORY);
    return {
      ...summaryOf(position),
      gateways,
      orders: [...unpaid, ...settled].map((r) =>
        orderResponse(r, resellerNames),
      ),
      payments: payments.map(paymentResponse),
    };
  }

  /**
   * Send the seller to a gateway to clear their balance. Nothing is recorded
   * here - the payment counts when the money lands (`recordGatewayPayment`).
   */
  async pay(
    shopId: string,
    gateway?: CollectingGateway,
  ): Promise<{ paymentUrl: string; amount: number }> {
    const position = await this.reconcile(shopId);
    if (position.balanceCents <= 0) {
      throw new BadRequestException('There is nothing to pay right now.');
    }
    const available = await this.gatewayCheckout.available();
    if (!available.length) {
      throw new BadRequestException(
        'Online payment is not available right now - please try again shortly.',
      );
    }
    if (gateway && !available.includes(gateway)) {
      throw new BadRequestException(
        `${this.gatewayCheckout.label(gateway)} is not available right now - please pick another method.`,
      );
    }
    const amountCents = Math.max(position.balanceCents, MIN_GATEWAY_CENTS);
    const shop = await this.db.query.shops.findFirst({
      where: eq(shops.id, shopId),
      columns: {
        name: true,
        supportPhone: true,
        pickupPhone: true,
        pickupAddress: true,
        ownerId: true,
      },
    });
    if (!shop) throw new NotFoundException('Shop not found');
    const owner = await this.db.query.users.findFirst({
      where: eq(users.id, shop.ownerId),
      columns: { name: true, email: true, phone: true },
    });
    const { paymentUrl } = await this.gatewayCheckout.open({
      purpose: 'service_fee',
      gateway: gateway ?? available[0],
      amountCents,
      reference: 'FEE',
      entityId: shopId,
      productName:
        position.feePercent === 0
          ? 'Hoomri supplier balance'
          : 'Hoomri service fee',
      shopId,
      customer: {
        name: owner?.name ?? shop.name,
        email: owner?.email ?? '',
        phone: owner?.phone ?? shop.pickupPhone ?? shop.supportPhone ?? '',
        address: shop.pickupAddress ?? shop.name,
        city: 'Dhaka',
        postcode: '1000',
      },
    });
    return { paymentUrl, amount: centsToDollars(amountCents) };
  }

  /**
   * A gateway charge for a service-fee session has landed.
   *
   * Every real charge counts, including a second one against a session that
   * was already paid: unlike an order there is nothing to deliver twice, and
   * money a seller has sent is money off their balance - anything beyond
   * what they owe stays as credit. Unique on the gateway's own transaction
   * id, so the redirect and the IPN describing one charge are one row.
   */
  async recordGatewayPayment(
    attempt: GatewayPaymentRow,
    charge: {
      transactionId: string | null;
      gatewayTxnId: string;
      amountCents: number;
    },
  ): Promise<void> {
    if (!attempt.shopId) return;
    const [row] = await this.db
      .insert(serviceFeePayments)
      .values({
        shopId: attempt.shopId,
        amountCents: charge.amountCents,
        via: 'gateway',
        gateway: attempt.provider,
        gatewayTxnId: charge.gatewayTxnId,
        paymentTransactionId: charge.transactionId,
      })
      .onConflictDoNothing({
        target: [serviceFeePayments.gateway, serviceFeePayments.gatewayTxnId],
      })
      .returning({ id: serviceFeePayments.id });
    if (row) await this.reconcile(attempt.shopId);
  }

  /* ── Platform console ──────────────────────────────────────────── */

  /** Every shop that owes, is in credit, or has ever paid. */
  async forPlatform(): Promise<PlatformServiceFeesResponse> {
    const catalog = await this.catalog();
    const [dueRows, paidRows] = await Promise.all([
      this.db.query.orders.findMany({
        where: owingOrders(),
        columns: FEE_COLUMNS,
      }),
      this.db
        .select({
          shopId: serviceFeePayments.shopId,
          paidCents:
            sql<number>`sum(${serviceFeePayments.amountCents})`.mapWith(Number),
          lastPaidAt: sql<Date>`max(${serviceFeePayments.paidAt})`.mapWith(
            (v: string) => new Date(v),
          ),
        })
        .from(serviceFeePayments)
        .groupBy(serviceFeePayments.shopId),
    ]);

    const byShop = new Map<
      string,
      { owedCents: number; unpaidOrders: number; marginCents: number }
    >();
    for (const row of dueRows) {
      const due = orderDue(row, catalog);
      if (due.dueCents <= 0) continue;
      const t = byShop.get(row.shopId) ?? {
        owedCents: 0,
        unpaidOrders: 0,
        marginCents: 0,
      };
      t.owedCents += due.dueCents;
      if (!row.duesPaidAt) {
        t.unpaidOrders += 1;
        t.marginCents += due.marginCents;
      }
      byShop.set(row.shopId, t);
    }
    const paid = new Map(paidRows.map((p) => [p.shopId, p]));
    const shopIds = [...new Set([...byShop.keys(), ...paid.keys()])];
    const shopRows = shopIds.length
      ? await this.db.query.shops.findMany({
          where: inArray(shops.id, shopIds),
          columns: {
            id: true,
            name: true,
            handle: true,
            duesOverSince: true,
            suspendedFor: true,
            suspendedAt: true,
          },
        })
      : [];

    const rows: PlatformServiceFeeRowResponse[] = shopRows
      .map((s) => {
        const owed = byShop.get(s.id);
        const balanceCents =
          (owed?.owedCents ?? 0) - (paid.get(s.id)?.paidCents ?? 0);
        const suspended = s.suspendedFor === 'dues';
        const standing = standingOf(balanceCents, s.duesOverSince, suspended);
        return {
          shopId: s.id,
          shopName: s.name,
          shopHandle: s.handle,
          outstanding: centsToDollars(Math.max(0, balanceCents)),
          credit: centsToDollars(Math.max(0, -balanceCents)),
          // Of what is outstanding, how much is reseller money passing
          // through rather than the platform's own fee.
          resellerMargin: centsToDollars(
            Math.min(owed?.marginCents ?? 0, Math.max(0, balanceCents)),
          ),
          unpaidOrders: owed?.unpaidOrders ?? 0,
          standing,
          suspended,
          overSince: s.duesOverSince?.toISOString(),
          payBy:
            s.duesOverSince && standing !== 'clear' && standing !== 'open'
              ? payByOf(s.duesOverSince).toISOString()
              : undefined,
          lastPaidAt: paid.get(s.id)?.lastPaidAt.toISOString(),
        };
      })
      .sort(
        (a, b) =>
          Number(b.suspended) - Number(a.suspended) ||
          b.outstanding - a.outstanding,
      );

    return {
      ...termsOf(),
      rows,
      totalOutstanding: rows.reduce((sum, r) => sum + r.outstanding, 0),
      suspendedShops: rows.filter((r) => r.suspended).length,
    };
  }

  /** One shop's statement, as the operator sees it. */
  async statementForPlatform(
    shopId: string,
  ): Promise<ServiceFeeStatementResponse> {
    return this.statementFor(shopId);
  }

  /**
   * Operator: record money a seller sent some other way - a bank transfer,
   * cash at the office. It counts exactly as a gateway payment does.
   */
  async recordManualPayment(
    shopId: string,
    input: { amountCents: number; note?: string; recordedBy?: string },
  ): Promise<ServiceFeeStatementResponse> {
    if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
      throw new BadRequestException('Enter the amount that was received.');
    }
    await this.requireShop(shopId);
    await this.db.insert(serviceFeePayments).values({
      shopId,
      amountCents: input.amountCents,
      via: 'manual',
      note: input.note?.trim() || null,
      recordedBy: input.recordedBy ?? null,
    });
    return this.statementFor(shopId);
  }

  /**
   * What each of these shops owes right now, in paisa (negative = credit).
   * For the payout screen, which sends a shop its money net of this.
   */
  async balancesFor(shopIds: string[]): Promise<Map<string, number>> {
    const balances = await Promise.all(
      shopIds.map((id) => serviceFeeBalanceCents(this.db, id)),
    );
    return new Map(shopIds.map((id, i) => [id, balances[i]]));
  }

  /* ── The engine ────────────────────────────────────────────────── */

  /**
   * Bring one shop up to date and say where it stands.
   *
   * Runs on every read, after every payment and on the sweep. Under the shop
   * row's lock, so a payment landing while the sweep is looking at the same
   * shop cannot have the two disagree about which orders are covered.
   */
  async reconcile(shopId: string): Promise<Position> {
    const catalog = await this.catalog();
    const now = new Date();
    const outcome = await this.db.transaction(async (tx) => {
      const [shop] = await tx
        .select({
          id: shops.id,
          name: shops.name,
          ownerId: shops.ownerId,
          businessType: shops.businessType,
          duesOverSince: shops.duesOverSince,
          suspendedAt: shops.suspendedAt,
          suspendedFor: shops.suspendedFor,
        })
        .from(shops)
        .where(eq(shops.id, shopId))
        .for('update');
      if (!shop) throw new NotFoundException('Shop not found');

      const [found, [paid]] = await Promise.all([
        tx.query.orders.findMany({
          where: and(eq(orders.shopId, shopId), owingOrders()),
          columns: FEE_COLUMNS,
        }),
        tx
          .select({
            cents:
              sql<number>`coalesce(sum(${serviceFeePayments.amountCents}), 0)`.mapWith(
                Number,
              ),
          })
          .from(serviceFeePayments)
          .where(eq(serviceFeePayments.shopId, shopId)),
      ]);

      const rows: DueRow[] = found
        .map((o) => ({ ...o, due: orderDue(o, catalog) }))
        .filter((o) => o.due.dueCents > 0)
        .sort((a, b) => owedSince(a).getTime() - owedSince(b).getTime());

      const { cover, uncover, balanceCents } = allocate(
        rows.map((r) => ({
          id: r.id,
          dueCents: r.due.dueCents,
          paid: !!r.duesPaidAt,
        })),
        paid.cents,
      );
      if (cover.length) {
        await tx
          .update(orders)
          .set({ duesPaidAt: now })
          .where(inArray(orders.id, cover));
      }
      if (uncover.length) {
        await tx
          .update(orders)
          .set({ duesPaidAt: null })
          .where(inArray(orders.id, uncover));
      }
      for (const r of rows) {
        if (cover.includes(r.id)) r.duesPaidAt = now;
        else if (uncover.includes(r.id)) r.duesPaidAt = null;
      }

      // Where the shop stands, and what that changes.
      const wasSuspended = shop.suspendedFor === 'dues';
      let overSince = shop.duesOverSince;
      let suspended = wasSuspended;
      let event: 'over' | 'suspended' | 'restored' | null = null;

      if (wasSuspended) {
        // Only a cleared balance reopens the shop - being back under the
        // limit is not enough once it has been closed over it.
        if (balanceCents <= 0) {
          suspended = false;
          overSince = null;
          event = 'restored';
          await tx
            .update(shops)
            .set({
              suspendedAt: null,
              suspendedReason: null,
              suspendedFor: null,
              duesOverSince: null,
              live: true,
            })
            .where(eq(shops.id, shopId));
        }
      } else if (!isOverLimit(balanceCents)) {
        if (overSince) {
          overSince = null;
          await tx
            .update(shops)
            .set({ duesOverSince: null })
            .where(eq(shops.id, shopId));
        }
      } else if (!overSince) {
        // The clock starts when the balance is *seen* over the limit, not
        // back-dated to the delivery that took it there: a seller marking a
        // week-old order delivered must still get their full three days.
        overSince = now;
        event = 'over';
        await tx
          .update(shops)
          .set({ duesOverSince: now })
          .where(eq(shops.id, shopId));
      } else if (
        now.getTime() > payByOf(overSince).getTime() &&
        // An operator's own suspension is theirs; it is left exactly as is.
        !shop.suspendedAt
      ) {
        suspended = true;
        event = 'suspended';
        await tx
          .update(shops)
          .set({
            suspendedAt: now,
            suspendedFor: 'dues',
            suspendedReason:
              'An outstanding balance is overdue. Pay it from Payouts to reopen your shop.',
            live: false,
          })
          .where(eq(shops.id, shopId));
      }

      return {
        position: {
          feePercent: salesFeeBp(shop.businessType) / 100,
          shopId,
          rows,
          balanceCents,
          overSince,
          suspended,
          standing: standingOf(balanceCents, overSince, suspended, now),
        } satisfies Position,
        event,
        shop,
      };
    });

    if (outcome.event) {
      void this.tellOwner(outcome.shop, outcome.event, outcome.position).catch(
        (err) =>
          this.logger.warn(`Could not email a service-fee notice: ${err}`),
      );
    }
    return outcome.position;
  }

  /**
   * Check every shop that could have changed: one with an order it has not
   * paid the fee on, or one already on the clock or suspended. It is the
   * sweep, not a seller opening their console, that suspends a shop whose
   * days have run out.
   */
  private async sweep(): Promise<void> {
    try {
      const [owing, flagged] = await Promise.all([
        this.db
          .selectDistinct({ shopId: orders.shopId })
          .from(orders)
          .where(and(owingOrders(), isNull(orders.duesPaidAt))),
        this.db
          .select({ shopId: shops.id })
          .from(shops)
          .where(
            or(isNotNull(shops.duesOverSince), eq(shops.suspendedFor, 'dues')),
          ),
      ]);
      const ids = new Set([...owing, ...flagged].map((r) => r.shopId));
      for (const shopId of ids) {
        try {
          await this.reconcile(shopId);
        } catch (err) {
          this.logger.error(
            `Service-fee check failed for shop ${shopId}`,
            err as Error,
          );
        }
      }
    } catch (err) {
      this.logger.error('Service-fee sweep failed', err as Error);
    }
  }

  /* ── Helpers ───────────────────────────────────────────────────── */

  private async catalog(): Promise<MethodCatalog> {
    return this.methods.byCode();
  }

  private async requireShop(shopId: string): Promise<void> {
    const shop = await this.db.query.shops.findFirst({
      where: eq(shops.id, shopId),
      columns: { id: true },
    });
    if (!shop) throw new NotFoundException('Shop not found');
  }

  private async shopNames(
    ids: (string | null)[],
  ): Promise<Map<string, string>> {
    const wanted = [...new Set(ids.filter((id): id is string => !!id))];
    if (!wanted.length) return new Map();
    const rows = await this.db.query.shops.findMany({
      where: inArray(shops.id, wanted),
      columns: { id: true, name: true },
    });
    return new Map(rows.map((s) => [s.id, s.name]));
  }

  /** A change in standing is never silent: the owner hears about each one. */
  private async tellOwner(
    shop: { name: string; ownerId: string },
    event: 'over' | 'suspended' | 'restored',
    position: Position,
  ): Promise<void> {
    const owner = await this.db.query.users.findFirst({
      where: eq(users.id, shop.ownerId),
      columns: { email: true, name: true },
    });
    if (!owner?.email) return;
    const amount = `৳${centsToDollars(Math.max(0, position.balanceCents)).toLocaleString('en-US')}`;
    const payBy = position.overSince
      ? payByOf(position.overSince).toLocaleDateString('en-GB', {
          day: 'numeric',
          month: 'long',
          timeZone: 'Asia/Dhaka',
        })
      : '';
    const balanceName =
      position.feePercent === 0 ? 'supplier balance' : 'service fee balance';
    const balanceSource =
      position.feePercent === 0
        ? 'reseller money you collected or online processing your proceeds did not cover'
        : 'orders you collected payment for';
    const copy = {
      over: {
        subject: `${shop.name}: ${balanceName} of ${amount} to pay by ${payBy}`,
        lines: [
          `Your shop ${shop.name} has a ${balanceName} of ${amount} from ${balanceSource}.`,
          `Please pay it by ${payBy} to keep your shop open. It takes a minute: open your seller console, go to Payouts and choose Pay.`,
        ],
      },
      suspended: {
        subject: `${shop.name} is paused until its outstanding balance is paid`,
        lines: [
          `Your shop ${shop.name} has been paused because a ${balanceName} of ${amount} was not paid in time.`,
          'Nothing is lost. Open your seller console, go to Payouts and choose Pay - your shop reopens the moment the balance is cleared.',
        ],
      },
      restored: {
        subject: `${shop.name} is open again`,
        lines: [
          `Thank you - the outstanding balance for ${shop.name} is cleared and your shop is live again.`,
        ],
      },
    }[event];
    const hello = `Hello ${owner.name?.split(' ')[0] || 'there'},`;
    await this.mail.send({
      to: owner.email,
      subject: copy.subject,
      text: [hello, ...copy.lines, 'Hoomri'].join('\n\n'),
      html: [hello, ...copy.lines, 'Hoomri']
        .map((line) => `<p>${escapeHtml(line)}</p>`)
        .join(''),
    });
  }
}

/* ── Ordering ────────────────────────────────────────────────────── */

/** When an order started owing - what "oldest first" is sorted on. */
function owedSince(row: {
  deliveredAt: Date | null;
  handedOverAt: Date | null;
  placedAt: Date;
}): Date {
  return row.deliveredAt ?? row.handedOverAt ?? row.placedAt;
}

/* ── Response shapes ─────────────────────────────────────────────── */

function termsOf() {
  return {
    feePercent: SERVICE_FEE_BP / 100,
    limit: centsToDollars(SERVICE_FEE_DUE_LIMIT_CENTS),
    graceDays: Math.round(SERVICE_FEE_GRACE_MS / 86_400_000),
  };
}

function summaryOf(position: Position): ServiceFeeSummaryResponse {
  const onClock =
    position.standing === 'due' || position.standing === 'overdue';
  return {
    ...termsOf(),
    feePercent: position.feePercent,
    outstanding: centsToDollars(Math.max(0, position.balanceCents)),
    credit: centsToDollars(Math.max(0, -position.balanceCents)),
    standing: position.standing,
    suspended: position.suspended,
    unpaidOrders: position.rows.filter((r) => !r.duesPaidAt).length,
    overSince: position.overSince?.toISOString(),
    payBy:
      onClock && position.overSince
        ? payByOf(position.overSince).toISOString()
        : undefined,
  };
}

function orderResponse(
  row: DueRow,
  resellerNames: Map<string, string>,
): ServiceFeeOrderResponse {
  return {
    id: row.id,
    reference: row.reference,
    customer: row.customerName,
    at: owedSince(row).toISOString(),
    collected: centsToDollars(row.due.collectedCents),
    feePercent:
      row.due.collectedCents === 0 && row.due.feeCents > 0
        ? SERVICE_FEE_BP / 100
        : row.platformFeeBp / 100,
    fee: centsToDollars(row.due.feeCents),
    resellerMargin: centsToDollars(row.due.marginCents),
    reseller: row.resellerShopId
      ? resellerNames.get(row.resellerShopId)
      : undefined,
    due: centsToDollars(row.due.dueCents),
    paidAt: row.duesPaidAt?.toISOString(),
  };
}

function paymentResponse(row: ServiceFeePaymentRow): ServiceFeePaymentResponse {
  return {
    id: row.id,
    amount: centsToDollars(row.amountCents),
    via: row.via,
    gateway: row.gateway ?? undefined,
    reference: row.gatewayTxnId ?? row.note ?? undefined,
    payoutPeriod: row.payoutPeriod ?? undefined,
    paidAt: row.paidAt.toISOString(),
  };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
