import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { centsToDollars, dollarsToCents } from '../../common/utils/money.util';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import {
  paymentLinks,
  paymentTransactions,
  settlements,
  shops as shopsTable,
  subscriptions,
  users,
} from '../../database/schema';
import type {
  GatewayPaymentRow,
  PaymentLinkRow,
  PaymentMethodRow,
  ShopRow,
} from '../../database/schema';
import { BlockedWordsService } from '../blocked-words/blocked-words.service';
import { GatewayCheckoutService } from '../gateways/gateway-checkout.service';
import { RefundsService, type RefundOutcome } from '../refunds/refunds.service';
import { PaymentMethodsService } from '../settlements/payment-methods.service';
import { periodOf } from '../settlements/settlement-core';
import { creditPosition } from '../subscriptions/credit-balance';
import { ShopsService } from '../shops/shops.service';
import type {
  CreatePaymentLinkDto,
  PayPaymentLinkDto,
} from './dto/payment-link.dto';
import { PAYMENT_LINK_MIN } from './dto/payment-link.dto';
import type {
  PayPaymentLinkResponse,
  PaymentLinkListResponse,
  PaymentLinkResponse,
  PaymentLinkState,
  PublicPaymentLinkResponse,
} from './dto/payment-link.response';

/** Read aloud and typed back, so no 0/O or 1/I/L - same set as account ids. */
const TOKEN_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
// 31^14 is ~7.6e20: far past guessing, still short enough to fit in an SMS.
const TOKEN_LENGTH = 14;
/** How many links the console lists. A shop's working set, not its archive. */
const LIST_LIMIT = 200;

function mintToken(): string {
  const bytes = randomBytes(TOKEN_LENGTH);
  let out = '';
  for (let i = 0; i < TOKEN_LENGTH; i++) {
    out += TOKEN_ALPHABET[bytes[i] % TOKEN_ALPHABET.length];
  }
  return out;
}

/**
 * How a charge for a link was applied: it paid the link, it was a second
 * telling of the charge that already did, or it was a separate charge for a
 * link that no longer needs paying.
 */
export type LinkSettleResult = 'paid' | 'already' | 'duplicate';

/** Where a link stands right now - the stored status, plus the deadline. */
export function paymentLinkState(
  link: Pick<PaymentLinkRow, 'status' | 'expiresAt'>,
  now = new Date(),
): PaymentLinkState {
  if (link.status !== 'active') return link.status;
  return link.expiresAt && link.expiresAt <= now ? 'expired' : 'active';
}

/**
 * Payment links: a shop asks one buyer for an amount by URL, and the buyer
 * pays it through SSLCommerz's hosted page.
 *
 * Three callers. The seller's console creates, lists and cancels. The public
 * page reads a link by its token and opens a checkout session for it. And the
 * return leg (PaymentsService) calls {@link settlePaid} when a session's
 * money has actually landed - this service never decides that for itself.
 *
 * SSLCommerz only, on purpose: it is the one gateway here that fronts cards,
 * net banking and the wallets from a single page, which is what a buyer with
 * nothing but a link needs. The fee a payment carries at payout is that of
 * the catalogue method SSLCommerz collects for.
 */
@Injectable()
export class PaymentLinksService {
  private readonly logger = new Logger(PaymentLinksService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly shops: ShopsService,
    private readonly methods: PaymentMethodsService,
    private readonly checkout: GatewayCheckoutService,
    private readonly config: ConfigService,
    private readonly refunds: RefundsService,
    private readonly blockedWords: BlockedWordsService,
  ) {}

  /* ── Seller console ────────────────────────────────────────────── */

  async listForShop(shopId: string): Promise<PaymentLinkListResponse> {
    const [shop, method, totals, rows] = await Promise.all([
      this.shops.requireById(shopId),
      this.collectingMethod(),
      // Over every link the shop has made, not just the page listed below.
      this.db
        .select({
          currency: paymentLinks.currency,
          collectedCents: sql<string>`coalesce(sum(${paymentLinks.settledAmountCents}) filter (where ${paymentLinks.status} = 'paid'), 0)`,
          collectedCount: sql<string>`count(*) filter (where ${paymentLinks.status} = 'paid')`,
          awaitingCents: sql<string>`coalesce(sum(${paymentLinks.amountCents}) filter (where ${paymentLinks.status} = 'active' and (${paymentLinks.expiresAt} is null or ${paymentLinks.expiresAt} > now())), 0)`,
          awaitingCount: sql<string>`count(*) filter (where ${paymentLinks.status} = 'active' and (${paymentLinks.expiresAt} is null or ${paymentLinks.expiresAt} > now()))`,
        })
        .from(paymentLinks)
        .where(eq(paymentLinks.shopId, shopId))
        .groupBy(paymentLinks.currency),
      this.db.query.paymentLinks.findMany({
        where: eq(paymentLinks.shopId, shopId),
        orderBy: desc(paymentLinks.createdAt),
        limit: LIST_LIMIT,
      }),
    ]);
    return {
      available: !!method && this.shopCanCollect(shop),
      feePercent: method ? method.feeBp / 100 : undefined,
      summary: {
        collected: centsToDollars(
          totals.reduce((sum, row) => sum + Number(row.collectedCents), 0),
        ),
        collectedCount: totals.reduce(
          (sum, row) => sum + Number(row.collectedCount),
          0,
        ),
        // Keep the legacy total in BDT; currencies cannot be added together.
        awaiting: centsToDollars(
          Number(
            totals.find((row) => row.currency === 'BDT')?.awaitingCents ?? 0,
          ),
        ),
        awaitingCount: totals.reduce(
          (sum, row) => sum + Number(row.awaitingCount),
          0,
        ),
        awaitingByCurrency: totals
          .filter((row) => Number(row.awaitingCount) > 0)
          .sort((a, b) => a.currency.localeCompare(b.currency))
          .map((row) => ({
            currency: row.currency,
            amount: centsToDollars(Number(row.awaitingCents)),
          })),
      },
      links: rows.map((row) => this.toResponse(row)),
    };
  }

  async create(
    shopId: string,
    dto: CreatePaymentLinkDto,
  ): Promise<PaymentLinkResponse> {
    const currency = dto.currency ?? 'BDT';
    if (currency === 'BDT' && dto.amount < PAYMENT_LINK_MIN) {
      throw new BadRequestException(
        `The minimum BDT amount is ${PAYMENT_LINK_MIN}.`,
      );
    }
    const shop = await this.shops.requireById(shopId);
    // Refused up front rather than at the buyer's end: a link that cannot be
    // paid is worse than no link, because the seller has already sent it.
    if (!this.shopCanCollect(shop)) {
      throw new BadRequestException(
        'Your shop is closed right now, so it cannot collect payments.',
      );
    }
    if (!(await this.collectingMethod())) {
      throw new BadRequestException(
        'Online payments are temporarily unavailable - please try again later.',
      );
    }
    // The title and details are shown to a stranger under the platform's
    // name, so they pass the same word list a shop name does.
    await this.blockedWords.assertClean(dto.title);
    if (dto.description) await this.blockedWords.assertClean(dto.description);
    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;
    if (expiresAt && expiresAt <= new Date()) {
      throw new BadRequestException('The expiry has to be in the future.');
    }

    // The token's unique index is the real guard; a collision is one in
    // ~10^20, so a single retry is already more than this will ever need.
    for (let attempt = 0; ; attempt++) {
      try {
        const [row] = await this.db
          .insert(paymentLinks)
          .values({
            shopId,
            token: mintToken(),
            title: dto.title,
            description: dto.description ?? null,
            amountCents: dollarsToCents(dto.amount),
            currency,
            expiresAt,
          })
          .returning();
        return this.toResponse(row);
      } catch (err) {
        const duplicate = (err as { code?: string }).code === '23505';
        if (!duplicate || attempt >= 2) throw err;
      }
    }
  }

  /** Stop an unpaid link collecting. A paid one is a record and stays. */
  async cancel(shopId: string, id: string): Promise<PaymentLinkResponse> {
    const [row] = await this.db
      .update(paymentLinks)
      .set({ status: 'cancelled' })
      .where(
        and(
          eq(paymentLinks.id, id),
          eq(paymentLinks.shopId, shopId),
          eq(paymentLinks.status, 'active'),
        ),
      )
      .returning();
    if (row) return this.toResponse(row);

    const existing = await this.db.query.paymentLinks.findFirst({
      where: and(eq(paymentLinks.id, id), eq(paymentLinks.shopId, shopId)),
    });
    if (!existing) throw new NotFoundException('Payment link not found');
    if (existing.status === 'paid' || existing.status === 'refunded') {
      throw new ConflictException(
        'This link has already been paid and cannot be cancelled.',
      );
    }
    return this.toResponse(existing);
  }

  /**
   * Send a paid link's money back to the buyer, through the gateway.
   *
   * The link is claimed as 'refunded' before the gateway is asked, so two
   * clicks cannot file two refunds; if the gateway refuses outright the claim
   * is undone and the seller is told why. A gateway that merely could not be
   * reached keeps the claim - the refund is on file and the sweep retries it.
   *
   * Refused once the money has been paid out to the seller: the platform no
   * longer holds it, so returning it is between the seller and the buyer.
   */
  async refund(shopId: string, id: string): Promise<PaymentLinkResponse> {
    const link = await this.db.query.paymentLinks.findFirst({
      where: and(eq(paymentLinks.id, id), eq(paymentLinks.shopId, shopId)),
    });
    if (!link) throw new NotFoundException('Payment link not found');
    if (link.status === 'refunded') {
      throw new ConflictException('This payment has already been refunded.');
    }
    if (link.status !== 'paid' || !link.paidAt || !link.trxId) {
      throw new ConflictException('Only a paid link can be refunded.');
    }

    const payout = await this.db.query.settlements.findFirst({
      where: and(
        eq(settlements.shopId, shopId),
        eq(settlements.period, periodOf(link.paidAt)),
      ),
      columns: { paidAt: true },
    });
    // A payout recorded before this payment landed does not include it.
    if (payout && payout.paidAt >= link.paidAt) {
      throw new ConflictException(
        'This payment has already been paid out to you, so it can no longer be refunded from here. Please return the money to the buyer directly.',
      );
    }

    const charge = await this.db.query.paymentTransactions.findFirst({
      where: and(
        eq(paymentTransactions.provider, 'sslcommerz'),
        eq(paymentTransactions.gatewayTxnId, link.trxId),
      ),
      columns: { id: true },
    });
    if (!charge) {
      throw new ConflictException(
        'We could not find the charge for this payment. Please contact support.',
      );
    }

    const [claimed] = await this.db
      .update(paymentLinks)
      .set({ status: 'refunded', refundedAt: new Date() })
      .where(and(eq(paymentLinks.id, id), eq(paymentLinks.status, 'paid')))
      .returning();
    if (!claimed) {
      throw new ConflictException('This payment has already been refunded.');
    }

    const unclaim = () =>
      this.db
        .update(paymentLinks)
        .set({ status: 'paid', refundedAt: null })
        .where(
          and(eq(paymentLinks.id, id), eq(paymentLinks.status, 'refunded')),
        );
    let outcome: RefundOutcome;
    try {
      outcome = await this.refunds.refundTransaction(charge.id, {
        reason: `Refund of payment link: ${link.title}`,
        initiatedBy: 'seller',
      });
    } catch (err) {
      await unclaim();
      throw err;
    }
    if (outcome.status === 'failed') {
      await unclaim();
      throw new BadRequestException(
        `The payment gateway refused the refund${outcome.reason ? `: ${outcome.reason}` : '.'}`,
      );
    }
    return this.toResponse(claimed);
  }

  /* ── Public page ───────────────────────────────────────────────── */

  async getPublic(token: string): Promise<PublicPaymentLinkResponse> {
    const { link, shop } = await this.requireByToken(token);
    const state = paymentLinkState(link);
    const paid = state === 'paid' || state === 'refunded';
    return {
      token: link.token,
      title: link.title,
      description: link.description ?? undefined,
      amount: centsToDollars(link.amountCents),
      currency: link.currency,
      state,
      payable:
        state === 'active' &&
        this.shopCanCollect(shop) &&
        !!(await this.collectingMethod()),
      expiresAt: link.expiresAt?.toISOString(),
      paidAt: paid ? link.paidAt?.toISOString() : undefined,
      trxId: paid ? (link.trxId ?? undefined) : undefined,
      shopName: shop.name,
      shopHandle: shop.handle,
    };
  }

  /**
   * Open a hosted-checkout session for the link and hand back its page.
   *
   * Nothing about the link changes here - a session is an attempt, and a
   * buyer who backs out must be able to try again. Each attempt carries its
   * own copy of who is paying; the one that settles is the one that counts.
   */
  async pay(
    token: string,
    dto: PayPaymentLinkDto,
  ): Promise<PayPaymentLinkResponse> {
    const { link, shop } = await this.requireByToken(token);
    const state = paymentLinkState(link);
    if (state === 'paid' || state === 'refunded') {
      throw new ConflictException('This payment has already been made.');
    }
    if (state !== 'active') {
      throw new BadRequestException(
        state === 'expired'
          ? 'This payment link has expired - ask the shop for a new one.'
          : 'This payment link is no longer active.',
      );
    }
    if (!this.shopCanCollect(shop) || !(await this.collectingMethod())) {
      throw new BadRequestException(
        'This shop cannot take online payments right now - please try again later.',
      );
    }

    const { paymentUrl } = await this.checkout.open({
      purpose: 'payment_link',
      gateway: 'sslcommerz',
      amountCents: link.amountCents,
      currency: link.currency,
      reference: 'PAY',
      entityId: link.token,
      productName: link.title,
      shopId: shop.id,
      paymentLinkId: link.id,
      payerDetails: {
        name: dto.name,
        phone: dto.phone,
        email: dto.email,
        note: dto.note,
      },
      customer: {
        name: dto.name,
        // The gateway refuses a session without an email, and most buyers
        // here do not have one to give - so the shop's stands in. It is only
        // where SSLCommerz would send its own receipt.
        email: dto.email ?? (await this.fallbackEmail(shop)),
        phone: dto.phone,
        address: '',
        city: '',
        postcode: '',
      },
    });
    return { paymentUrl };
  }

  /* ── Return leg ────────────────────────────────────────────────── */

  /**
   * A charge for this link has landed: mark the link paid and copy across
   * who paid it. Called by PaymentsService once the charge is recorded.
   *
   * Only a link still waiting can be paid - but "waiting" includes one the
   * seller cancelled, or whose deadline passed, while the buyer was on the
   * gateway's page. That money has moved and is the shop's; turning it away
   * would leave a real charge attached to nothing. (The seller can refund it.)
   *
   * Anything else is told apart by the transaction id: the same charge
   * arriving again (the redirect and the gateway's own notification both
   * report it) is 'already', and changes nothing. A *different* charge for a
   * link that is paid or refunded is 'duplicate' - money that bought nothing,
   * which the caller sends back.
   */
  async settlePaid(
    attempt: GatewayPaymentRow,
    charge: { gatewayTxnId: string; amountCents: number; instrument?: string },
  ): Promise<LinkSettleResult> {
    if (!attempt.paymentLinkId) return 'already';
    const method = await this.collectingMethod({ includeDisabled: true });
    const payer = attempt.payerDetails;
    const [claimed] = await this.db
      .update(paymentLinks)
      .set({
        status: 'paid',
        settledAmountCents: charge.amountCents,
        paidAt: new Date(),
        trxId: charge.gatewayTxnId,
        paymentMethod: method?.code ?? null,
        instrument: charge.instrument?.slice(0, 60) ?? null,
        payerName: payer?.name ?? null,
        payerPhone: payer?.phone ?? null,
        payerEmail: payer?.email ?? null,
        payerNote: payer?.note ?? null,
      })
      .where(
        and(
          eq(paymentLinks.id, attempt.paymentLinkId),
          inArray(paymentLinks.status, ['active', 'cancelled']),
        ),
      )
      .returning({ id: paymentLinks.id, shopId: paymentLinks.shopId });
    if (claimed) {
      await this.closeIfCreditSpent(claimed.shopId);
      return 'paid';
    }

    const existing = await this.db.query.paymentLinks.findFirst({
      where: eq(paymentLinks.id, attempt.paymentLinkId),
      columns: { trxId: true },
    });
    if (existing?.trxId === charge.gatewayTxnId) return 'already';
    this.logger.warn(
      `Payment link ${attempt.paymentLinkId} was paid a second time (${charge.gatewayTxnId})`,
    );
    return 'duplicate';
  }

  /**
   * The same rule a checkout applies: the sale that spends the last of a
   * shop's pre-paid credit stands, and the shop closes behind it until the
   * seller tops up. Never throws - the payment is already settled, and a
   * failure here must not make it look otherwise.
   */
  private async closeIfCreditSpent(shopId: string): Promise<void> {
    try {
      const credit = await creditPosition(this.db, shopId);
      if (!credit || credit.balanceCents > 0) return;
      await this.db
        .update(shopsTable)
        .set({ live: false })
        .where(eq(shopsTable.id, shopId));
      await this.db
        .update(subscriptions)
        .set({ creditExhaustedAt: new Date() })
        .where(eq(subscriptions.shopId, shopId));
    } catch (err) {
      this.logger.error(
        `Could not check sales credit for shop ${shopId} after a link payment`,
        err as Error,
      );
    }
  }

  /** The public token for a session's link - where its payer is sent back. */
  async tokenFor(paymentLinkId: string | null): Promise<string | undefined> {
    if (!paymentLinkId) return undefined;
    const row = await this.db.query.paymentLinks.findFirst({
      where: eq(paymentLinks.id, paymentLinkId),
      columns: { token: true },
    });
    return row?.token;
  }

  /* ── Internals ─────────────────────────────────────────────────── */

  private async requireByToken(
    token: string,
  ): Promise<{ link: PaymentLinkRow; shop: ShopRow }> {
    // Tokens are minted uppercase; a hand-typed one is forgiven its case.
    const cleaned = token.trim().toUpperCase();
    const link = /^[A-Z0-9]{8,24}$/.test(cleaned)
      ? await this.db.query.paymentLinks.findFirst({
          where: eq(paymentLinks.token, cleaned),
        })
      : undefined;
    if (!link) throw new NotFoundException('Payment link not found');
    return { link, shop: await this.shops.requireById(link.shopId) };
  }

  /**
   * The catalogue method SSLCommerz collects for, when it can collect at all.
   * Its fee rate is what a paid link is settled under.
   *
   * `includeDisabled` is for the settling side: money that has already landed
   * still needs a method to be paid out under, even if the operator switched
   * card payments off while the buyer was on the gateway's page.
   */
  private async collectingMethod(
    opts: { includeDisabled?: boolean } = {},
  ): Promise<PaymentMethodRow | undefined> {
    const catalog = [...(await this.methods.byCode()).values()]
      .filter((m) => m.gateway === 'sslcommerz')
      .sort((a, b) => a.sortOrder - b.sortOrder);
    const enabled = catalog.find((m) => m.enabled);
    if (opts.includeDisabled) return enabled ?? catalog[0];
    if (!enabled) return undefined;
    return (await this.checkout.isConfigured('sslcommerz'))
      ? enabled
      : undefined;
  }

  /** Open for business: not switched off, not paused for billing, not locked. */
  private shopCanCollect(shop: ShopRow): boolean {
    return shop.live && !shop.suspendedAt;
  }

  private async fallbackEmail(shop: ShopRow): Promise<string> {
    if (shop.supportEmail) return shop.supportEmail;
    const owner = await this.db.query.users.findFirst({
      where: eq(users.id, shop.ownerId),
      columns: { email: true },
    });
    return owner?.email ?? 'payments@hoomri.com';
  }

  private toResponse(row: PaymentLinkRow): PaymentLinkResponse {
    return {
      id: row.id,
      token: row.token,
      url: this.linkUrl(row.token),
      title: row.title,
      description: row.description ?? undefined,
      amount: centsToDollars(row.amountCents),
      currency: row.currency,
      settledAmount:
        row.settledAmountCents == null
          ? undefined
          : centsToDollars(row.settledAmountCents),
      state: paymentLinkState(row),
      expiresAt: row.expiresAt?.toISOString(),
      createdAt: row.createdAt.toISOString(),
      paidAt: row.paidAt?.toISOString(),
      trxId: row.trxId ?? undefined,
      instrument: row.instrument ?? undefined,
      payerName: row.payerName ?? undefined,
      payerPhone: row.payerPhone ?? undefined,
      payerEmail: row.payerEmail ?? undefined,
      payerNote: row.payerNote ?? undefined,
      refundedAt: row.refundedAt?.toISOString(),
    };
  }

  private linkUrl(token: string): string {
    const webUrl = (
      this.config.get<string>('app.webUrl') ?? 'http://localhost:5173'
    ).replace(/\/$/, '');
    return `${webUrl}/pay/${token}`;
  }
}
