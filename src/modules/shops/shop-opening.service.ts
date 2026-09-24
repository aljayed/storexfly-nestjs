import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { and, desc, eq, lt, ne } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import { shopDrafts, users } from '../../database/schema';
import type { GatewayPaymentRow, ShopDraftRow } from '../../database/schema';
import { isUniqueViolationOn } from '../../common/utils/postgres-error.util';
import { BillingSettingsService } from '../billing/billing-settings.service';
import { CouponsService } from '../coupons/coupons.service';
import {
  GatewayCheckoutService,
  type CollectingGateway,
} from '../gateways/gateway-checkout.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { CreateShopDto } from './dto/create-shop.dto';
import { ShopResponse } from './dto/shop.response';
import { ShopsService } from './shops.service';

/** How long a filled-in shop holds its name while its owner goes to pay. */
export const DRAFT_HOLD_MS = 60 * 60 * 1000;
const SWEEP_EVERY_MS = 5 * 60 * 1000;
const HANDLE_INDEX = 'shop_drafts_handle_pending_idx';

export interface ShopDraftView {
  id: string;
  name: string;
  handle: string;
  status: ShopDraftRow['status'];
  /** When the hold on the handle lapses. */
  expiresAt: string;
  packCode: string | null;
  /** Present once the payment has landed and the shop has been written. */
  shop?: ShopResponse;
}

/**
 * Opening a shop, which is a purchase.
 *
 * A shop costs a credit pack. That means the wizard cannot end with a shop -
 * it ends with a *draft*: everything the seller filled in, validated, and
 * holding its handle for an hour while they are away on the gateway's page.
 * The shop is written by {@link settlePaidDraft}, which only the settling
 * side of a payment calls, so an abandoned or failed checkout leaves nothing
 * behind but a name that frees itself.
 *
 * Everything here is written to be arrived at twice. A gateway will tell you
 * about the same payment by redirect and by IPN, sometimes at once, so the
 * draft is claimed with a conditional update and whoever loses that race does
 * nothing.
 */
@Injectable()
export class ShopOpeningService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ShopOpeningService.name);
  private sweepTimer?: ReturnType<typeof setInterval>;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly shops: ShopsService,
    private readonly subscriptions: SubscriptionsService,
    private readonly billing: BillingSettingsService,
    private readonly coupons: CouponsService,
    private readonly gatewayCheckout: GatewayCheckoutService,
  ) {}

  onModuleInit(): void {
    this.sweepTimer = setInterval(() => {
      void this.sweepExpired();
    }, SWEEP_EVERY_MS);
    this.sweepTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  /* ── The wizard's submit ───────────────────────────────────────── */

  /**
   * Take the finished wizard, check all of it, and hold the name.
   *
   * Validation happens here rather than at payment time because this is the
   * last moment a complaint can still be pointed at the field that caused it.
   * It runs again when the money lands, on the chance that an hour changed
   * the answer.
   */
  async start(ownerId: string, dto: CreateShopDto): Promise<ShopDraftView> {
    const prepared = await this.shops.prepareShop(ownerId, dto);
    const handle = prepared.handle;

    // One live draft per seller: coming back and changing the name should
    // release the old name rather than sit on both.
    await this.db
      .update(shopDrafts)
      .set({ status: 'cancelled' })
      .where(
        and(
          eq(shopDrafts.ownerId, ownerId),
          eq(shopDrafts.status, 'pending'),
          ne(shopDrafts.handle, handle),
        ),
      );
    // A lapsed hold still occupies the unique index until something says so.
    await this.releaseLapsed(handle);

    const expiresAt = new Date(Date.now() + DRAFT_HOLD_MS);
    try {
      const [row] = await this.db
        .insert(shopDrafts)
        .values({
          ownerId,
          handle,
          name: dto.name.trim(),
          payload: dto,
          expiresAt,
        })
        .onConflictDoNothing()
        .returning();
      if (row) return this.view(row);
    } catch (err) {
      if (!isUniqueViolationOn(err, HANDLE_INDEX)) throw err;
    }

    // Either the seller is resuming their own draft for this name, or
    // somebody else got the name between the check above and this insert.
    const existing = await this.db.query.shopDrafts.findFirst({
      where: and(
        eq(shopDrafts.handle, handle),
        eq(shopDrafts.status, 'pending'),
      ),
    });
    if (!existing || existing.ownerId !== ownerId) {
      throw new ConflictException({
        error: 'HandleTaken',
        message: 'That shop link is already taken. Choose another one.',
      });
    }
    // Their own: refresh it with what they just submitted, and give them a
    // fresh hour to pay in - they have only just told us they are still here.
    const [updated] = await this.db
      .update(shopDrafts)
      .set({
        name: dto.name.trim(),
        payload: dto,
        expiresAt,
      })
      .where(eq(shopDrafts.id, existing.id))
      .returning();
    return this.view(updated);
  }

  /** The seller's live draft, if they left one behind. */
  async mine(ownerId: string): Promise<ShopDraftView | null> {
    const row = await this.db.query.shopDrafts.findFirst({
      where: and(
        eq(shopDrafts.ownerId, ownerId),
        eq(shopDrafts.status, 'pending'),
      ),
      orderBy: desc(shopDrafts.createdAt),
    });
    if (!row) return null;
    if (row.expiresAt.getTime() <= Date.now()) {
      await this.expire(row.id);
      return null;
    }
    return this.view(row);
  }

  /** What became of one draft - what the wizard polls after the gateway. */
  async statusFor(ownerId: string, id: string): Promise<ShopDraftView> {
    const row = await this.requireOwned(ownerId, id);
    if (row.status === 'pending' && row.expiresAt.getTime() <= Date.now()) {
      await this.expire(row.id);
      return this.view({ ...row, status: 'expired' });
    }
    return this.view(row);
  }

  /** Give the name back on purpose - the seller went back to change it. */
  async cancel(ownerId: string, id: string): Promise<void> {
    const row = await this.requireOwned(ownerId, id);
    if (row.status !== 'pending') return;
    await this.db
      .update(shopDrafts)
      .set({ status: 'cancelled' })
      .where(and(eq(shopDrafts.id, row.id), eq(shopDrafts.status, 'pending')));
  }

  /* ── Paying for it ─────────────────────────────────────────────── */

  /**
   * Send the seller to the gateway for the pack that opens this shop.
   *
   * Nothing is written here beyond which pack they picked. A coupon that
   * takes the price to nothing is the one case that opens the shop on the
   * spot: there is no sense sending somebody to a payment page to pay zero.
   */
  async pay(
    ownerId: string,
    id: string,
    input: {
      packCode: string;
      couponCode?: string;
      gateway?: CollectingGateway;
      refSlug?: string;
    },
  ): Promise<{ paymentUrl: string | null; shop?: ShopResponse }> {
    const draft = await this.requireLive(ownerId, id);
    const pack = await this.billing.packByCode(input.packCode);
    if (!pack || !pack.active) {
      throw new BadRequestException('That credit pack is not available.');
    }

    let coupon: { code: string } | undefined;
    let discountCents = 0;
    if (input.couponCode?.trim()) {
      const check = await this.coupons.check(input.couponCode, ownerId, pack);
      if (!check.ok) {
        throw new BadRequestException(check.message);
      }
      coupon = check.coupon;
      discountCents = check.discountCents;
    }
    const amountDueCents = Math.max(0, pack.priceCents - discountCents);

    await this.db
      .update(shopDrafts)
      .set({ packCode: pack.code, couponCode: coupon?.code ?? null })
      .where(eq(shopDrafts.id, draft.id));

    if (amountDueCents === 0) {
      const shop = await this.openShop(draft, {
        packCode: pack.code,
        amountCents: 0,
        discountCents,
        couponCode: coupon?.code ?? null,
        refSlug: input.refSlug ?? null,
        provider: null,
        transactionId: null,
        gatewayTxnId: null,
      });
      return { paymentUrl: null, shop };
    }

    const available = await this.gatewayCheckout.available();
    if (!available.length) {
      throw new BadRequestException(
        'Online payment is not available right now - please try again shortly.',
      );
    }
    if (input.gateway && !available.includes(input.gateway)) {
      throw new BadRequestException(
        `${this.gatewayCheckout.label(input.gateway)} is not available right now - please pick another method.`,
      );
    }
    const chosen =
      input.gateway && available.includes(input.gateway)
        ? input.gateway
        : available[0];

    const owner = await this.db.query.users.findFirst({
      where: eq(users.id, ownerId),
      columns: { name: true, email: true, phone: true },
    });
    const payload = draft.payload as Partial<CreateShopDto>;
    const { paymentUrl } = await this.gatewayCheckout.open({
      purpose: 'shop_opening',
      gateway: chosen,
      amountCents: amountDueCents,
      reference: 'SHOP',
      entityId: draft.id,
      productName: `${pack.name} - opening ${draft.name}`,
      shopDraftId: draft.id,
      packCode: pack.code,
      couponCode: coupon?.code,
      discountCents,
      refSlug: input.refSlug,
      customer: {
        name: owner?.name ?? draft.name,
        email: owner?.email ?? payload.supportEmail ?? '',
        phone:
          owner?.phone ?? payload.pickupPhone ?? payload.supportPhone ?? '',
        address: payload.pickupAddress ?? draft.name,
        city: payload.pickupDistrict ?? 'Dhaka',
        postcode: '1000',
      },
    });
    return { paymentUrl };
  }

  /* ── The money lands ───────────────────────────────────────────── */

  /**
   * Write the shop this payment opened. Called by the settling side of a
   * gateway session and nowhere else.
   *
   * An expired hold is not a reason to refuse: somebody who paid at minute
   * sixty-one has paid, and keeping the money without opening the shop is the
   * one outcome worth avoiding. What can still refuse is the name being gone,
   * and that is loud on purpose - it means a person has to be given their
   * money back or their name sorted out by hand.
   */
  async settlePaidDraft(
    attempt: GatewayPaymentRow,
    charge: { transactionId: string | null; gatewayTxnId: string },
  ): Promise<void> {
    if (!attempt.shopDraftId) {
      this.logger.error(
        `Shop-opening payment ${attempt.paymentId} settled without a draft on the session`,
      );
      return;
    }
    // Claim it: whoever wins this update opens the shop, and a second
    // notification about the same payment finds nothing to claim.
    const [draft] = await this.db
      .update(shopDrafts)
      .set({ status: 'paid', paidAt: new Date() })
      .where(
        and(
          eq(shopDrafts.id, attempt.shopDraftId),
          eq(shopDrafts.status, 'pending'),
        ),
      )
      .returning();
    if (!draft) return;

    await this.openShop(draft, {
      packCode: attempt.packCode,
      amountCents: attempt.amountCents,
      discountCents: attempt.discountCents,
      couponCode: attempt.couponCode,
      refSlug: attempt.refSlug,
      provider: attempt.provider,
      transactionId: charge.transactionId,
      gatewayTxnId: charge.gatewayTxnId,
    });
  }

  /**
   * The shop itself: validate the hour-old submission once more, write it,
   * and hand it the pack that was paid for.
   */
  private async openShop(
    draft: ShopDraftRow,
    purchase: {
      packCode: string | null;
      amountCents: number;
      discountCents: number;
      couponCode: string | null;
      refSlug: string | null;
      provider: string | null;
      transactionId: string | null;
      gatewayTxnId: string | null;
    },
  ): Promise<ShopResponse> {
    const dto = draft.payload as CreateShopDto;
    let shopId: string;
    let response: ShopResponse;
    try {
      const values = await this.shops.prepareShop(draft.ownerId, dto);
      const row = await this.shops.createPreparedShop(draft.ownerId, values);
      shopId = row.id;
      response = ShopResponse.fromRowForConsole(row);
    } catch (err) {
      await this.db
        .update(shopDrafts)
        .set({ status: 'failed' })
        .where(eq(shopDrafts.id, draft.id));
      this.logger.error(
        `Paid shop "${draft.handle}" (draft ${draft.id}, owner ${draft.ownerId}) could not be opened after payment - this seller has paid for a shop they do not have`,
        err as Error,
      );
      throw err;
    }

    await this.db
      .update(shopDrafts)
      .set({ status: 'paid', shopId, paidAt: draft.paidAt ?? new Date() })
      .where(eq(shopDrafts.id, draft.id));

    // The pack lands on the shop it just opened. Failing here leaves a real
    // shop with no credit rather than a lost payment, which is recoverable
    // by hand - so it is logged rather than unwound.
    if (purchase.packCode) {
      try {
        await this.subscriptions.grantPurchasedCredit(
          {
            shopId,
            packCode: purchase.packCode,
            amountCents: purchase.amountCents,
            discountCents: purchase.discountCents,
            couponCode: purchase.couponCode,
            refSlug: purchase.refSlug,
            provider: purchase.provider ?? '',
          },
          {
            transactionId: purchase.transactionId,
            gatewayTxnId: purchase.gatewayTxnId ?? '',
          },
        );
      } catch (err) {
        this.logger.error(
          `Shop ${shopId} opened but its ${purchase.packCode} pack was not granted`,
          err as Error,
        );
      }
    }
    return response;
  }

  /* ── Housekeeping ──────────────────────────────────────────────── */

  /** Let go of every hold whose hour is up. */
  private async sweepExpired(): Promise<void> {
    try {
      const released = await this.db
        .update(shopDrafts)
        .set({ status: 'expired' })
        .where(
          and(
            eq(shopDrafts.status, 'pending'),
            lt(shopDrafts.expiresAt, new Date()),
          ),
        )
        .returning({ id: shopDrafts.id });
      if (released.length) {
        this.logger.log(
          `Released ${released.length} unpaid shop name(s) back to the pool`,
        );
      }
    } catch (err) {
      this.logger.error('Shop-draft sweep failed', err as Error);
    }
  }

  /** Free one lapsed hold now, so a fresh draft may take the name. */
  private async releaseLapsed(handle: string): Promise<void> {
    await this.db
      .update(shopDrafts)
      .set({ status: 'expired' })
      .where(
        and(
          eq(shopDrafts.handle, handle),
          eq(shopDrafts.status, 'pending'),
          lt(shopDrafts.expiresAt, new Date()),
        ),
      );
  }

  private async expire(id: string): Promise<void> {
    await this.db
      .update(shopDrafts)
      .set({ status: 'expired' })
      .where(and(eq(shopDrafts.id, id), eq(shopDrafts.status, 'pending')));
  }

  private async requireOwned(
    ownerId: string,
    id: string,
  ): Promise<ShopDraftRow> {
    const row = await this.db.query.shopDrafts.findFirst({
      where: eq(shopDrafts.id, id),
    });
    if (!row || row.ownerId !== ownerId) {
      throw new NotFoundException('That shop setup could not be found.');
    }
    return row;
  }

  private async requireLive(
    ownerId: string,
    id: string,
  ): Promise<ShopDraftRow> {
    const row = await this.requireOwned(ownerId, id);
    if (row.status === 'paid') {
      throw new ConflictException({
        error: 'DraftAlreadyPaid',
        message: 'This shop has already been opened.',
      });
    }
    if (row.status !== 'pending' || row.expiresAt.getTime() <= Date.now()) {
      await this.expire(row.id);
      throw new ConflictException({
        error: 'DraftExpired',
        message:
          'This shop setup expired and its link was released. Start again to pick it back up.',
      });
    }
    return row;
  }

  private async view(row: ShopDraftRow): Promise<ShopDraftView> {
    const shop = row.shopId ? await this.shops.getById(row.shopId) : undefined;
    return {
      id: row.id,
      name: row.name,
      handle: row.handle,
      status: row.status,
      expiresAt: row.expiresAt.toISOString(),
      packCode: row.packCode,
      ...(shop ? { shop } : {}),
    };
  }
}
