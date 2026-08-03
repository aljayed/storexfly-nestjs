import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, count, desc, eq, ne, notInArray, sql } from 'drizzle-orm';
import { BRAND_SWATCHES } from '../../common/constants/brand-swatches';
import { contactComplete } from '../../common/utils/contact-verification.util';
import { centsToDollars } from '../../common/utils/money.util';
import { handleize } from '../../common/utils/slug.util';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import {
  deletedShopSettlements,
  orders,
  products,
  settlements,
  shops,
  subscriptionPayments,
  subscriptions,
  users,
  type PayoutBank,
  type ShopRow,
} from '../../database/schema';
import {
  addOrder,
  classify,
  emptyBuckets,
  payoutCents,
  periodOf,
  totalFeeCents,
  windowOf,
  type Buckets,
  type MonthCore,
} from '../settlements/settlement-core';
import { EmailOtpService } from '../auth/email-otp.service';
import { BlockedWordsService } from '../blocked-words/blocked-words.service';
import { StorageService } from '../storage/storage.service';
import { ProductResponse } from '../products/dto/product.response';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import type { CreateShopDto } from './dto/create-shop.dto';
import type { SubmitKycDto } from './dto/kyc.dto';
import { KycResponse } from './dto/kyc.response';
import { ShopResponse } from './dto/shop.response';
import { DiscoverResponse } from './dto/discover.response';
import type { UpdateShopDto } from './dto/update-shop.dto';

const FEATURED_LIMIT = 8;
// Cards per section on the public marketplace feed (logged-in no-shop home).
const DISCOVER_LIMIT = 12;

// EmailOtpService namespace for the delete-shop confirmation codes.
const DELETE_OTP_SCOPE = 'shop-delete';

/** One unsettled earnings month owed to a shop being deleted. */
interface OwedMonth {
  period: string;
  core: MonthCore;
  payoutCents: number;
  feeCents: number;
}

/** Whether a seller who already owns a shop may open another one. */
export interface ShopEligibility {
  shopCount: number;
  /** The free trial is the first shop only. */
  freeTrialAvailable: boolean;
  /** Any shop of theirs with a verified trade licence. */
  hasVerifiedBusiness: boolean;
  /** Credit packs this seller has ever bought, across all their shops. */
  creditPacksBought: number;
  /** One is spent per shop opened beyond the free first one. */
  creditPacksUsed: number;
  canCreate: boolean;
}

/** "৳1,200" - the platform bills in taka, so no currency lookup is needed. */
function taka(cents: number): string {
  return `৳${(cents / 100).toLocaleString('en-US')}`;
}

/** j***b@gmail.com - enough for the owner to recognise the inbox. */
function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  const first = local.slice(0, 1);
  const last = local.length > 1 ? local.slice(-1) : '';
  return `${first}***${last}@${domain}`;
}

@Injectable()
export class ShopsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly subscriptionsService: SubscriptionsService,
    private readonly blockedWords: BlockedWordsService,
    private readonly storage: StorageService,
    private readonly emailOtp: EmailOtpService,
  ) {}

  /** Live handle availability check for the onboarding wizard. */
  async checkHandle(handle: string): Promise<{ available: boolean }> {
    const normalized = handleize(handle);
    if (!normalized) {
      return { available: false };
    }
    const existing = await this.db.query.shops.findFirst({
      where: eq(shops.handle, normalized),
      columns: { id: true },
    });
    return { available: !existing };
  }

  async create(ownerId: string, dto: CreateShopDto): Promise<ShopResponse> {
    const plan = dto.plan ?? 'paid';
    // Both a verified email and a verified phone, whatever the plan - an
    // account nobody can be reached on has no business opening a storefront.
    await this.assertContactVerified(ownerId);
    const owned = await this.db.query.shops.findMany({
      where: eq(shops.ownerId, ownerId),
      columns: { id: true, kycStatus: true },
    });
    if (owned.length) {
      // The free tier is a first-shop trial, not a way to run a fleet of
      // capped shops: any existing shop (free or paid) means this one is paid.
      if (plan === 'free') {
        throw new ForbiddenException(
          'The free trial is only for your first shop - a second one starts on a paid track.',
        );
      }
      await this.assertSecondShopAllowed(ownerId, owned);
    }
    // Nothing is charged to open a shop. The seller picks how they pay for
    // sales - a credit pack, or the verified commission track - from the
    // console once the shop exists.
    const handle = handleize(dto.handle);
    await this.blockedWords.assertClean(dto.name);
    await this.blockedWords.assertClean(handle);
    const taken = await this.db.query.shops.findFirst({
      where: eq(shops.handle, handle),
      columns: { id: true },
    });
    if (taken) {
      throw new ForbiddenException('That handle is already taken');
    }
    const swatch = BRAND_SWATCHES[dto.brandId];
    const [row] = await this.db
      .insert(shops)
      .values({
        name: dto.name,
        handle,
        tagline: dto.tagline,
        cat: dto.cat,
        brandId: dto.brandId,
        brand: swatch.c,
        brandSoft: swatch.soft,
        ownerId,
        plan,
        // Optional KYC supplied during onboarding - skipped sellers start
        // 'unsubmitted' (the column default).
        ...this.kycPatch(dto.kyc),
      })
      .returning();
    // Every shop gets a billing record straight away: the credits track with
    // a zero balance, so the console has something to show and the meter
    // starts counting from the shop's first day.
    await this.subscriptionsService.openForNewShop(ownerId, row.id);
    return ShopResponse.fromRow(row);
  }

  /**
   * Whether this seller may open another shop, and why. The wizard reads it
   * up front so a locked seller is shown the two ways out instead of filling
   * in five steps and being refused at the end.
   */
  async eligibility(ownerId: string): Promise<ShopEligibility> {
    const owned = await this.db.query.shops.findMany({
      where: eq(shops.ownerId, ownerId),
      columns: { id: true, kycStatus: true },
    });
    return this.additionalShopUnlock(ownerId, owned);
  }

  /**
   * The first shop is free to open - that is the trial. Every shop after it
   * has to come from a seller who has shown they are a real merchant, in one
   * of the two ways the platform already recognises: a verified trade licence,
   * or a credit pack bought for each shop they open. Both are done from the
   * console of a shop they already have, and either one unlocks the next shop
   * the moment it lands.
   */
  private async assertSecondShopAllowed(
    ownerId: string,
    owned: { kycStatus: ShopRow['kycStatus'] }[],
  ): Promise<void> {
    const unlock = await this.additionalShopUnlock(ownerId, owned);
    if (unlock.canCreate) {
      return;
    }
    throw new ForbiddenException({
      statusCode: HttpStatus.FORBIDDEN,
      error: 'AdditionalShopLocked',
      message: unlock.creditPacksBought
        ? `Every shop after your first one opens on its own credit pack, and the ${unlock.creditPacksUsed === 1 ? 'one you bought is' : `${unlock.creditPacksUsed} you bought are`} already carrying the shops you have. Buy another pack - or get your trade licence verified - to open this one.`
        : 'Your first shop is the free trial. To open another one, buy a credit pack or get your trade licence verified from your shop console - the new shop unlocks as soon as either goes through.',
    });
  }

  /**
   * The two things that unlock a seller's second (and every later) shop.
   *
   * A verified trade licence covers every shop they open. Credit packs don't:
   * one is spent per shop beyond the free first one, so a seller running three
   * shops on the pre-paid track has bought at least two packs. Packs are
   * counted per *seller*, not per shop - the ledger row survives its shop
   * being deleted (the FK nulls `shopId`), which also hands the slot back when
   * a shop goes, exactly as it would have if the shop had never been opened.
   */
  private async additionalShopUnlock(
    ownerId: string,
    owned: { kycStatus: ShopRow['kycStatus'] }[],
  ): Promise<ShopEligibility> {
    const [{ n }] = await this.db
      .select({ n: count() })
      .from(subscriptionPayments)
      .where(
        and(
          eq(subscriptionPayments.userId, ownerId),
          eq(subscriptionPayments.type, 'credit_pack'),
        ),
      );
    const creditPacksBought = Number(n);
    const creditPacksUsed = Math.max(0, owned.length - 1);
    const hasVerifiedBusiness = owned.some((s) => s.kycStatus === 'verified');
    return {
      shopCount: owned.length,
      freeTrialAvailable: owned.length === 0,
      hasVerifiedBusiness,
      creditPacksBought,
      creditPacksUsed,
      canCreate:
        owned.length === 0 ||
        hasVerifiedBusiness ||
        creditPacksBought > creditPacksUsed,
    };
  }

  /**
   * Shop creation requires a verified email and a verified phone number on
   * the account. The 403 carries a machine-readable `error` so the wizard can
   * drop the seller back onto the verification step (which re-reads
   * /auth/verify/status for the per-field detail) instead of matching on the
   * message text.
   */
  private async assertContactVerified(ownerId: string): Promise<void> {
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, ownerId),
      columns: {
        email: true,
        emailVerified: true,
        phone: true,
        phoneVerified: true,
      },
    });
    if (!user) {
      throw new ForbiddenException('Account no longer exists');
    }
    if (!contactComplete(user)) {
      throw new ForbiddenException({
        statusCode: HttpStatus.FORBIDDEN,
        error: 'ContactVerificationRequired',
        message:
          'Verify your email address and phone number before creating a shop.',
      });
    }
  }

  /**
   * Public marketplace feed - live shops plus the newest products across
   * them, for buyers browsing outside any single storefront. Only the cover
   * image travels per product; the full data-URL arrays would put megabytes
   * on what should be a light feed.
   */
  async discover(): Promise<DiscoverResponse> {
    const [shopRows, productRows] = await Promise.all([
      this.db.query.shops.findMany({
        where: eq(shops.live, true),
        orderBy: [desc(shops.createdAt)],
        limit: DISCOVER_LIMIT,
        columns: {
          name: true,
          handle: true,
          tagline: true,
          cat: true,
          brand: true,
          brandSoft: true,
        },
      }),
      this.db
        .select({
          name: products.name,
          slug: products.slug,
          listingType: products.listingType,
          priceCents: products.priceCents,
          unit: products.unit,
          stock: products.stock,
          emoji: products.emoji,
          tone: products.tone,
          tag: products.tag,
          rating: products.rating,
          reviews: products.reviewsCount,
          image: sql<string | null>`(${products.images})[1]`,
          shopHandle: shops.handle,
          shopName: shops.name,
          currency: shops.currency,
        })
        .from(products)
        .innerJoin(shops, eq(products.shopId, shops.id))
        .where(eq(shops.live, true))
        .orderBy(desc(products.createdAt))
        .limit(DISCOVER_LIMIT),
    ]);
    return {
      shops: shopRows.map((s) => ({ ...s, tagline: s.tagline ?? undefined })),
      products: productRows.map((p) => ({
        name: p.name,
        slug: p.slug,
        listingType: p.listingType,
        price: centsToDollars(p.priceCents),
        unit: p.unit,
        stock: p.stock,
        emoji: p.emoji,
        tone: p.tone,
        tag: p.tag ?? undefined,
        rating: p.rating,
        reviews: p.reviews,
        image: p.image ?? undefined,
        shopHandle: p.shopHandle,
        shopName: p.shopName,
        currency: p.currency,
      })),
    };
  }

  /** Public storefront load - shop + a slice of featured products. */
  async getByHandle(handle: string): Promise<{
    shop: ShopResponse;
    featured: ProductResponse[];
  }> {
    const shop = await this.requireLiveByHandle(handle);
    const featured = await this.db.query.products.findMany({
      where: eq(products.shopId, shop.id),
      orderBy: [desc(products.rating), desc(products.reviewsCount)],
      limit: FEATURED_LIMIT,
    });
    return {
      shop: ShopResponse.fromRow(shop),
      featured: featured.map(ProductResponse.fromRow),
    };
  }

  async getById(id: string): Promise<ShopResponse> {
    return ShopResponse.fromRow(await this.requireById(id));
  }

  async update(
    ownerId: string,
    id: string,
    dto: UpdateShopDto,
  ): Promise<ShopResponse> {
    const shop = await this.requireById(id);
    if (shop.ownerId !== ownerId) {
      throw new ForbiddenException('You do not own this shop');
    }
    return this.applyUpdate(id, dto);
  }

  /**
   * Console-path update - no owner check. Callers must have verified access
   * already (admin JWT scoped to this shop + the `settings.manage`
   * permission), which lets invited full-access managers edit settings.
   */
  async updateFromConsole(
    id: string,
    dto: UpdateShopDto,
  ): Promise<ShopResponse> {
    await this.requireById(id);
    return this.applyUpdate(id, dto);
  }

  private async applyUpdate(
    id: string,
    dto: UpdateShopDto,
  ): Promise<ShopResponse> {
    if (dto.name) {
      await this.blockedWords.assertClean(dto.name);
    }
    const patch: Partial<ShopRow> = {
      name: dto.name ?? undefined,
      tagline: dto.tagline ?? undefined,
      cat: dto.cat ?? undefined,
      currency: dto.currency ?? undefined,
      language: dto.language ?? undefined,
    };
    // Support contacts: an empty string clears the saved value.
    if (dto.supportEmail !== undefined) {
      patch.supportEmail = dto.supportEmail.trim() || null;
    }
    if (dto.supportPhone !== undefined) {
      patch.supportPhone = dto.supportPhone.trim() || null;
    }
    if (dto.brandId) {
      const swatch = BRAND_SWATCHES[dto.brandId];
      patch.brandId = dto.brandId;
      patch.brand = swatch.c;
      patch.brandSoft = swatch.soft;
    }
    // Banners are replace-all: an empty array clears them; null keeps the column
    // tidy when there are none left. Newly-added base64 images are uploaded to
    // object storage first; existing /media URLs pass through unchanged.
    if (dto.bannerImages !== undefined) {
      const banners = dto.bannerImages.map((b) => b.trim()).filter(Boolean);
      const uploaded = await this.storage.absorbMany(banners, 'shops');
      patch.bannerImages = uploaded && uploaded.length ? uploaded : null;
    }
    if (dto.floatingImages !== undefined) {
      const floats = dto.floatingImages.map((b) => b.trim()).filter(Boolean);
      const uploaded = await this.storage.absorbMany(floats, 'shops');
      patch.floatingImages = uploaded && uploaded.length ? uploaded : null;
    }
    // Trust badges are replace-all too: normalise text and drop empty-title
    // rows; an empty result stores null so the row stays tidy.
    if (dto.trustBadges !== undefined) {
      const badges = dto.trustBadges
        .map((b) => ({
          icon: b.icon,
          title: b.title.trim(),
          subtitle: b.subtitle.trim(),
          enabled: b.enabled,
        }))
        .filter((b) => b.title.length > 0);
      patch.trustBadges = badges.length ? badges : null;
    }
    const [row] = await this.db
      .update(shops)
      .set(patch)
      .where(eq(shops.id, id))
      .returning();
    return ShopResponse.fromRow(row);
  }

  /** Owner-only read of the full KYC record (includes the trade licence). */
  async getKyc(ownerId: string, id: string): Promise<KycResponse> {
    const shop = await this.requireById(id);
    if (shop.ownerId !== ownerId) {
      throw new ForbiddenException('You do not own this shop');
    }
    return KycResponse.fromRow(shop);
  }

  /**
   * Create or update the shop's business verification. Sellers can save
   * partial details and finish later; submitting (or replacing) the document
   * moves the shop into the 'pending' review state. Already-verified shops
   * keep their status when only the editable text fields change.
   */
  async submitKyc(
    ownerId: string,
    id: string,
    dto: SubmitKycDto,
  ): Promise<KycResponse> {
    const shop = await this.requireById(id);
    if (shop.ownerId !== ownerId) {
      throw new ForbiddenException('You do not own this shop');
    }
    const patch = this.kycPatch(dto, shop);
    if (Object.keys(patch).length === 0) {
      return KycResponse.fromRow(shop);
    }
    const [row] = await this.db
      .update(shops)
      .set(patch)
      .where(eq(shops.id, id))
      .returning();
    return KycResponse.fromRow(row);
  }

  /**
   * Build the KYC column patch from a (partial) submission. `current` is the
   * existing shop on an update (absent during onboarding).
   *
   * A submission (re)enters the operator's 'pending' review queue when either:
   *  - a fresh document is uploaded, or
   *  - a previously *rejected* shop resubmits - even with no new file - so the
   *    operator sees it again and the seller isn't stuck on 'rejected'.
   * A *verified* shop keeps its badge on text-only edits (only a new document
   * sends it back for review). Returns an empty object when nothing was given.
   */
  private kycPatch(dto?: SubmitKycDto, current?: ShopRow): Partial<ShopRow> {
    if (!dto) return {};
    const patch: Partial<ShopRow> = {};
    if (dto.legalName !== undefined) {
      patch.kycLegalName = dto.legalName.trim() || null;
    }
    if (dto.licenseNo !== undefined) {
      patch.kycLicenseNo = dto.licenseNo.trim() || null;
    }

    const hasNewDoc = dto.document !== undefined;
    if (hasNewDoc) {
      patch.kycDocument = dto.document!.trim() || null;
    }

    // A document must be on file for there to be anything to review - either
    // the one just uploaded, or the one already saved on a resubmission.
    const documentOnFile = hasNewDoc
      ? !!patch.kycDocument
      : !!current?.kycDocument;
    const resubmittingRejected = current?.kycStatus === 'rejected';
    if (documentOnFile && (hasNewDoc || resubmittingRejected)) {
      patch.kycStatus = 'pending';
      patch.kycSubmittedAt = new Date();
    }
    return patch;
  }

  async listForOwner(ownerId: string): Promise<ShopResponse[]> {
    const rows = await this.db.query.shops.findMany({
      where: eq(shops.ownerId, ownerId),
      orderBy: [desc(shops.createdAt)],
    });
    return rows.map(ShopResponse.fromRow);
  }

  // ── Payout bank account (where settlements are transferred) ───

  async getPayoutBank(shopId: string): Promise<{ bank: PayoutBank | null }> {
    const shop = await this.requireById(shopId);
    return { bank: shop.payoutBank ?? null };
  }

  /** Owner-set payout destination; `null` clears it. */
  async setPayoutBank(
    shopId: string,
    bank: PayoutBank | null,
  ): Promise<{ bank: PayoutBank | null }> {
    await this.requireById(shopId);
    const [row] = await this.db
      .update(shops)
      .set({ payoutBank: bank })
      .where(eq(shops.id, shopId))
      .returning({ payoutBank: shops.payoutBank });
    return { bank: row.payoutBank ?? null };
  }

  // ── Shop deletion (OTP-confirmed, owner only) ─────────────────

  /**
   * What stands between this shop and deletion, shown in the confirm
   * dialog before any code is sent.
   *
   * Blocking: orders still in progress, and post-paid commission the shop
   * hasn't paid us for the sales it has already made. Not blocking: unsettled
   * payout money (the seller is told when and where it will be transferred,
   * and must have a payout account on file), and pre-paid credit still on the
   * balance - that is the seller's to forfeit, as long as they are told the
   * figure and say they understand it.
   */
  async deletePrecheck(shopId: string): Promise<{
    inProgressOrders: number;
    pendingPayout: number;
    commissionOwed: number;
    creditBalance: number;
    currency: string;
    /** Billing is always in the platform's currency, whatever the shop sells in. */
    billingCurrency: string;
    months: {
      period: string;
      payout: number;
      windowFrom: string;
      windowTo: string;
    }[];
    hasBankAccount: boolean;
  }> {
    const shop = await this.requireById(shopId);
    const [inProgress, owed, position] = await Promise.all([
      this.inProgressOrderCount(shopId),
      this.owedSettlements(shopId),
      this.subscriptionsService.closingPosition(shopId),
    ]);
    const pendingCents = owed.reduce((sum, o) => sum + o.payoutCents, 0);
    return {
      inProgressOrders: inProgress,
      pendingPayout: centsToDollars(pendingCents),
      commissionOwed: centsToDollars(position.commissionOwedCents),
      creditBalance: centsToDollars(position.creditBalanceCents),
      currency: shop.currency,
      billingCurrency: position.currency,
      months: owed.map((o) => {
        const window = windowOf(o.period);
        return {
          period: o.period,
          payout: centsToDollars(o.payoutCents),
          windowFrom: window.from,
          windowTo: window.to,
        };
      }),
      hasBankAccount: !!shop.payoutBank,
    };
  }

  /**
   * Step 1 of deleting a shop: email a 6-digit confirmation code to the
   * shop *owner* (whoever triggers it, the code always goes to the owner's
   * account email). The code is scoped to this shop and expires in 10
   * minutes. Refused while orders are in progress, or while settlement
   * money is owed but no payout account is on file.
   */
  async requestDeleteOtp(
    shopId: string,
  ): Promise<{ sent: boolean; email: string }> {
    const shop = await this.requireById(shopId);
    await this.assertDeletable(shop);
    const email = await this.requireOwnerEmail(shop);
    await this.emailOtp.start(
      DELETE_OTP_SCOPE,
      email,
      { shopId },
      {
        subject: `Confirm deleting ${shop.name}`,
        heading: 'Confirm shop deletion',
        intro: `You asked to permanently delete your shop "${shop.name}" (hoomri.com/${shop.handle}). This cannot be undone. Your confirmation code is:`,
      },
    );
    return { sent: true, email: maskEmail(email) };
  }

  /**
   * Step 2: verify the emailed code and delete the shop. One transaction:
   * any money still owed to the seller is snapshotted into
   * `deleted_shop_settlements` (with the payout account and owner contact),
   * the subscription is cancelled, and the shop row is removed - billing
   * can never survive the shop (every dependent row, the subscription
   * included, cascades with the delete; the payments ledger is kept with
   * its shop reference nulled), and owed payouts can never be lost with it.
   * The guards re-run here: orders may have arrived after the code was sent.
   */
  async deleteWithOtp(
    shopId: string,
    code: string,
    creditAcknowledged = false,
  ): Promise<{ deleted: boolean; pendingPayout: number; currency: string }> {
    const shop = await this.requireById(shopId);
    const email = await this.requireOwnerEmail(shop);
    const payload = this.emailOtp.verify<{ shopId: string }>(
      DELETE_OTP_SCOPE,
      email,
      code,
    );
    if (!payload || payload.shopId !== shopId) {
      throw new ForbiddenException(
        'That code is invalid or has expired. Request a new one and try again.',
      );
    }
    const owed = await this.assertDeletable(shop, creditAcknowledged);
    await this.db.transaction(async (tx) => {
      if (owed.length) {
        await tx.insert(deletedShopSettlements).values(
          owed.map((o) => ({
            shopId: shop.id,
            shopName: shop.name,
            shopHandle: shop.handle,
            currency: shop.currency,
            ownerId: shop.ownerId,
            ownerEmail: email,
            period: o.period,
            ordersCount: o.core.ordersCount,
            totalCents: o.core.totalCents,
            feeCents: o.feeCents,
            payoutCents: o.payoutCents,
            breakdown: o.core.online,
            payoutBank: shop.payoutBank,
          })),
        );
      }
      // Belt and braces on the commission guard above: an order that landed
      // between the check and this transaction is billed rather than lost. The
      // ledger row survives the delete (its shopId is nulled by the FK), so
      // the seller's payment history stays honest - and a merchant can't sell
      // all month post-paid and delete the shop to avoid the bill.
      await this.subscriptionsService.settleOnClose(shopId, tx);
      await tx
        .update(subscriptions)
        .set({ status: 'cancelled', cancelledAt: new Date() })
        .where(eq(subscriptions.shopId, shopId));
      await tx.delete(shops).where(eq(shops.id, shopId));
    });
    return {
      deleted: true,
      pendingPayout: centsToDollars(
        owed.reduce((sum, o) => sum + o.payoutCents, 0),
      ),
      currency: shop.currency,
    };
  }

  /**
   * The deletion guards. Returns the owed settlement months so the delete
   * transaction can snapshot exactly what was checked.
   *
   * `creditAcknowledged` is only meaningful on the final delete: the seller
   * has to have seen the credit they are forfeiting and said so. Asking for it
   * when merely requesting the confirmation code would be premature - the
   * dialog shows the figure at that point, it doesn't have an answer yet.
   */
  private async assertDeletable(
    shop: ShopRow,
    creditAcknowledged = false,
  ): Promise<OwedMonth[]> {
    const inProgress = await this.inProgressOrderCount(shop.id);
    if (inProgress > 0) {
      throw new ConflictException(
        `${inProgress} order${inProgress === 1 ? ' is' : 's are'} still in progress. Deliver or cancel every order before deleting the shop.`,
      );
    }
    // Post-paid means we have already let this shop sell on trust. It doesn't
    // get to walk away from the bill for those sales: the seller settles it
    // from Billing, then comes back. Pre-paid credit is the opposite case -
    // that money is already ours, so it only has to be declared.
    const position = await this.subscriptionsService.closingPosition(shop.id);
    if (position.commissionOwedCents > 0) {
      throw new ConflictException(
        `You still owe ${taka(position.commissionOwedCents)} in commission on the sales this shop has already made. Settle it from Billing, then delete the shop.`,
      );
    }
    const owed = await this.owedSettlements(shop.id);
    if (owed.length && !shop.payoutBank) {
      throw new BadRequestException(
        'You have settlement money pending. Add the bank account it should be transferred to before deleting the shop.',
      );
    }
    if (position.creditBalanceCents > 0 && !creditAcknowledged) {
      throw new BadRequestException(
        `This shop still holds ${taka(position.creditBalanceCents)} of unused sales credit, which is forfeited when it is deleted. Confirm you understand that before continuing.`,
      );
    }
    return owed;
  }

  /** Orders neither delivered nor cancelled (in-flight gateway payments excluded). */
  private async inProgressOrderCount(shopId: string): Promise<number> {
    const [{ n }] = await this.db
      .select({ n: count() })
      .from(orders)
      .where(
        and(
          eq(orders.shopId, shopId),
          notInArray(orders.status, ['Delivered', 'Cancelled']),
          // Gateway payments still in flight auto-expire - never delivered,
          // never blocking.
          ne(orders.pay, 'Pending'),
        ),
      );
    return Number(n);
  }

  /**
   * Every earnings month (current month included) whose online payout is
   * still unpaid - the money the platform owes this seller. Mirrors
   * SettlementsService month math via the shared settlement-core helpers.
   */
  private async owedSettlements(shopId: string): Promise<OwedMonth[]> {
    const [methodRows, orderRows, paidRows] = await Promise.all([
      this.db.query.paymentMethods.findMany(),
      this.db.query.orders.findMany({
        where: and(eq(orders.shopId, shopId), eq(orders.pay, 'Paid')),
        columns: { totalCents: true, paymentMethod: true, placedAt: true },
      }),
      this.db.query.settlements.findMany({
        where: eq(settlements.shopId, shopId),
        columns: { period: true },
      }),
    ]);
    const catalog = new Map(methodRows.map((m) => [m.code, m]));
    const byPeriod = new Map<string, Buckets>();
    for (const r of orderRows) {
      const period = periodOf(r.placedAt);
      const b = byPeriod.get(period) ?? emptyBuckets();
      addOrder(b, r.paymentMethod, r.totalCents, 1);
      byPeriod.set(period, b);
    }
    const alreadyPaid = new Set(paidRows.map((p) => p.period));
    const owed: OwedMonth[] = [];
    for (const [period, buckets] of byPeriod) {
      if (alreadyPaid.has(period)) continue;
      const core = classify(buckets, catalog);
      const payout = payoutCents(core);
      if (payout > 0) {
        owed.push({
          period,
          core,
          payoutCents: payout,
          feeCents: totalFeeCents(core),
        });
      }
    }
    owed.sort((a, b) => a.period.localeCompare(b.period));
    return owed;
  }

  private async requireOwnerEmail(shop: ShopRow): Promise<string> {
    const owner = await this.db.query.users.findFirst({
      where: eq(users.id, shop.ownerId),
      columns: { email: true },
    });
    if (!owner?.email) {
      throw new BadRequestException(
        'The shop owner has no email on file, so a confirmation code cannot be sent.',
      );
    }
    return owner.email;
  }

  // ── Internal helpers shared with other modules ───────────────
  async requireById(id: string): Promise<ShopRow> {
    const shop = await this.db.query.shops.findFirst({
      where: eq(shops.id, id),
    });
    if (!shop) {
      throw new NotFoundException('Shop not found');
    }
    return shop;
  }

  async requireByHandle(handle: string): Promise<ShopRow> {
    const shop = await this.db.query.shops.findFirst({
      where: eq(shops.handle, handleize(handle)),
    });
    if (!shop) {
      throw new NotFoundException('Shop not found');
    }
    return shop;
  }

  /**
   * Like `requireByHandle`, but for buyer-facing routes: a shop that has been
   * switched off is invisible to buyers. The `ShopOffline` error code lets
   * the storefront render a dedicated "temporarily closed" page.
   */
  async requireLiveByHandle(handle: string): Promise<ShopRow> {
    const shop = await this.requireByHandle(handle);
    if (!shop.live) {
      throw new HttpException(
        {
          statusCode: HttpStatus.FORBIDDEN,
          error: 'ShopOffline',
          message: 'This shop is currently offline.',
        },
        HttpStatus.FORBIDDEN,
      );
    }
    return shop;
  }

  /** True if `handle` is unused by any shop other than `exceptId`. */
  async isHandleFree(handle: string, exceptId?: string): Promise<boolean> {
    const normalized = handleize(handle);
    const existing = await this.db.query.shops.findFirst({
      where: exceptId
        ? and(eq(shops.handle, normalized), ne(shops.id, exceptId))
        : eq(shops.handle, normalized),
      columns: { id: true },
    });
    return !existing;
  }
}
