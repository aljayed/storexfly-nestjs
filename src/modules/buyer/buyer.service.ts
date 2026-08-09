import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import * as bcrypt from 'bcryptjs';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import {
  orders,
  reviews,
  shops,
  users,
  type NewUserRow,
  type UserRow,
} from '../../database/schema';
import { centsToDollars } from '../../common/utils/money.util';
import { productLines } from '../../common/utils/order-line.util';
import { BlockedWordsService } from '../blocked-words/blocked-words.service';
import { RiskService } from '../risk/risk.service';
import {
  checkHandleShape,
  normalizeHandle,
  type HandleRejection,
} from './handle.util';
import { EmailOtpService } from '../auth/email-otp.service';
import { SessionScopeService } from '../auth/session-scope.service';
import { TokenService } from '../auth/token.service';
import {
  BuyerAuthResponse,
  BuyerLoginDto,
  BuyerRegisterDto,
} from './dto/buyer-auth.dto';
import type { ClaimOrderDto } from './dto/claim-order.dto';
import type {
  BuyerOverview,
  BuyerProfile,
  UpdateBuyerProfileDto,
} from './dto/buyer-overview.dto';

// Same cost as the seller sign-up path (auth.service): both write password
// hashes to the one `users` table, so they must not disagree on strength.
const BCRYPT_ROUNDS = 12;
const EMAIL_VERIFY_OTP_SCOPE = 'buyer-email-verify';
/** Codes issued when a second account is opened from one address. */
const SIGNUP_OTP_SCOPE = 'buyer-signup-verify';

/** Reduce any BD phone format to the bare 10-digit national number, so numbers
 *  captured as "+8801712…", "01712…" or "1712…" all compare equal. */
function normalizePhone(raw: string | null | undefined): string {
  return (raw ?? '')
    .replace(/\D/g, '')
    .replace(/^880/, '')
    .replace(/^0+/, '');
}

/**
 * Storefront-shopper account flows - register / login / profile - operating on
 * the unified `users` account (buyer & seller are one identity). Accounts made
 * here are ordinary `users` rows: the same email/password works at the seller
 * sign-in, and creating a shop turns the account into a seller. Issues the
 * account session token (`signSellerToken`); there is no separate buyer token.
 */
@Injectable()
export class BuyerService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly tokens: TokenService,
    private readonly emailOtp: EmailOtpService,
    private readonly blockedWords: BlockedWordsService,
    private readonly risk: RiskService,
    private readonly sessionScope: SessionScopeService,
  ) {}

  async findById(id: string): Promise<UserRow | undefined> {
    return this.db.query.users.findFirst({ where: eq(users.id, id) });
  }

  /** Accounts store email lower-cased, so look-ups normalize case. */
  private async findByEmail(email: string): Promise<UserRow | undefined> {
    return this.db.query.users.findFirst({
      where: eq(users.email, email.trim().toLowerCase()),
    });
  }

  /** Look up an account by its normalized (national 10-digit) phone number. */
  private async findByPhone(phone: string): Promise<UserRow | undefined> {
    const normalized = normalizePhone(phone);
    if (!normalized) return undefined;
    return this.db.query.users.findFirst({
      where: eq(users.phone, normalized),
    });
  }

  /** Throws if the name contains a blocked word, or the email/(normalized) phone is already taken. */
  private async assertAvailable(
    name: string,
    email: string,
    phone: string | null,
  ): Promise<void> {
    await this.blockedWords.assertClean(name);
    if (await this.findByEmail(email)) {
      throw new ConflictException({
        code: 'EMAIL_TAKEN',
        message: 'An account with this email already exists',
      });
    }
    // One account per phone number. Checked before insert so the buyer gets a
    // clear "this phone already has an account" message (and a sign-in path).
    if (phone && (await this.findByPhone(phone))) {
      throw new ConflictException({
        code: 'PHONE_TAKEN',
        message: 'This phone number is already associated with another account',
      });
    }
  }

  /**
   * Instant account creation for shoppers - the "create my account" tick at
   * checkout and the storefront sign-up modal. Deliberately not OTP-gated: a
   * shopper should never be made to leave for their inbox mid-purchase, and
   * the account is not a security boundary on its own. What keeps that safe is
   * the scope of the session it mints - nothing is verified, so `issue()`
   * hands back a `storefront` token that cannot touch the seller-side API.
   */
  async register(
    dto: BuyerRegisterDto,
    ip?: string | null,
  ): Promise<BuyerAuthResponse> {
    const phone = dto.phone ? normalizePhone(dto.phone) : null;
    await this.assertAvailable(dto.name, dto.email, phone);

    /**
     * The first account from an address in 12 hours is created on the spot,
     * as it always was - a shopper mid-purchase is never sent to their inbox.
     * The next one has to answer a code first, so a script cannot mint
     * accounts faster than it can read email.
     */
    const email = dto.email.trim().toLowerCase();
    const { requireEmailVerification } = await this.risk.assessSignup(ip);
    if (requireEmailVerification) {
      const proved = dto.emailCode
        ? this.emailOtp.verify<true>(SIGNUP_OTP_SCOPE, email, dto.emailCode)
        : null;
      if (!proved) {
        // Issue (or re-issue) the code and tell the client to collect it.
        await this.emailOtp.start(SIGNUP_OTP_SCOPE, email, true, {
          heading: 'Confirm your email',
          intro: 'Use this code to finish creating your Hoomri account:',
        });
        throw new ForbiddenException({
          code: 'EMAIL_VERIFICATION_REQUIRED',
          message:
            'Please confirm the code we emailed you to finish creating this account.',
        });
      }
    }

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    const [row] = await this.db
      .insert(users)
      .values({
        name: dto.name,
        email: dto.email.trim().toLowerCase(),
        passwordHash,
        via: 'email',
        // Seed the saved checkout details captured at inline checkout.
        phone,
        addressLine: dto.address || null,
        addressCity: dto.city || null,
        addressPincode: dto.pincode || null,
        geo: dto.geo ?? null,
      })
      .returning();
    void this.risk.record('signup', { ip, email, phone }).catch(() => undefined);
    return this.issue(row);
  }

  /**
   * Link a guest order to the signed-in account after it could not auto-attach
   * (the order's phone already belonged to this account). Proof of ownership is
   * the phone match. Linking rewrites the order's email to the account's, the
   * key order history and verified-purchase reviews match on.
   */
  async claimOrder(
    accountId: string,
    dto: ClaimOrderDto,
  ): Promise<{ linked: boolean }> {
    const account = await this.findById(accountId);
    if (!account) throw new UnauthorizedException('Account no longer exists');

    const order = await this.db.query.orders.findFirst({
      where: and(
        eq(orders.shopId, dto.shopId),
        eq(orders.reference, dto.reference),
      ),
    });
    if (!order) throw new NotFoundException('Order not found');

    // Already linked (email already matches, case-insensitively) - idempotent.
    if (
      account.email &&
      order.email.toLowerCase() === account.email.toLowerCase()
    ) {
      return { linked: true };
    }

    if (
      !account.email ||
      !account.phone ||
      normalizePhone(order.phone) !== normalizePhone(account.phone)
    ) {
      throw new ForbiddenException(
        'This order cannot be linked to your account',
      );
    }

    await this.db
      .update(orders)
      .set({ email: account.email })
      .where(eq(orders.id, order.id));
    return { linked: true };
  }

  async login(dto: BuyerLoginDto): Promise<BuyerAuthResponse> {
    const row = await this.findByEmail(dto.email);
    if (
      !row ||
      !row.passwordHash ||
      !(await bcrypt.compare(dto.password, row.passwordHash))
    ) {
      throw new UnauthorizedException('Invalid email or password');
    }
    return this.issue(row);
  }

  /**
   * Public profile shape. Async because the handle can come from the account's
   * shop - see {@link publicHandle}.
   */
  async me(row: UserRow): Promise<BuyerProfile> {
    const { handle, fromShop } = await this.publicHandle(row);
    return {
      id: row.id,
      name: row.name,
      email: row.email ?? '',
      phone: row.phone,
      address: row.addressLine,
      city: row.addressCity,
      pincode: row.addressPincode,
      geo: row.geo,
      lastPayMethod: row.lastPayMethod,
      emailVerified: row.emailVerified,
      handle,
      handleFromShop: fromShop,
    };
  }

  /**
   * Step 1 of verifying an account's email (the profile screen): email the
   * account's own address a fresh code. Used by accounts created inline at
   * checkout (never OTP-verified), whose guest orders can only be
   * repriced-with-approval once the email is confirmed.
   */
  async startEmailVerification(accountId: string): Promise<{ ok: true }> {
    const account = await this.findById(accountId);
    if (!account) throw new UnauthorizedException('Account no longer exists');
    if (!account.email) {
      throw new ConflictException('Add an email to your account first.');
    }
    if (account.emailVerified) {
      throw new ConflictException('Your email is already verified.');
    }
    await this.emailOtp.start<{ accountId: string }>(
      EMAIL_VERIFY_OTP_SCOPE,
      account.email,
      { accountId: account.id },
      {
        subject: 'Verify your email',
        heading: 'Verify your email',
        intro: 'Enter this code to verify your Hoomri account email:',
      },
    );
    return { ok: true };
  }

  /** Step 2: check the code and mark the account's email verified. */
  async confirmEmailVerification(
    accountId: string,
    code: string,
  ): Promise<BuyerProfile> {
    const account = await this.findById(accountId);
    if (!account) throw new UnauthorizedException('Account no longer exists');
    if (account.emailVerified) return this.me(account);
    if (!account.email) {
      throw new ConflictException('Add an email to your account first.');
    }
    const pending = this.emailOtp.verify<{ accountId: string }>(
      EMAIL_VERIFY_OTP_SCOPE,
      account.email,
      code,
    );
    if (!pending || pending.accountId !== account.id) {
      throw new UnauthorizedException('Invalid or expired code');
    }
    const [row] = await this.db
      .update(users)
      .set({ emailVerified: true })
      .where(eq(users.id, account.id))
      .returning();
    return this.me(row);
  }

  /**
   * Update the account's editable storefront fields (display name plus the saved
   * checkout details used to autofill the order form). Only the keys present in
   * the DTO are written, so a partial PATCH never clears untouched fields.
   */
  async updateProfile(
    accountId: string,
    dto: UpdateBuyerProfileDto,
  ): Promise<BuyerProfile> {
    const patch: Partial<NewUserRow> = {};
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.phone !== undefined) patch.phone = normalizePhone(dto.phone) || null;
    if (dto.address !== undefined) patch.addressLine = dto.address || null;
    if (dto.city !== undefined) patch.addressCity = dto.city || null;
    if (dto.pincode !== undefined) patch.addressPincode = dto.pincode || null;
    if (dto.geo !== undefined) patch.geo = dto.geo ?? null;
    if (dto.lastPayMethod !== undefined) {
      patch.lastPayMethod = dto.lastPayMethod || null;
    }

    const [row] = await this.db
      .update(users)
      .set(patch)
      .where(eq(users.id, accountId))
      .returning();
    if (!row) throw new UnauthorizedException('Account no longer exists');
    return this.me(row);
  }

  /**
   * Is this username free and allowed? Drives the live check under the field,
   * so it deliberately answers only about the name asked for - it is not a
   * directory, and never returns who holds a taken one.
   */
  async checkHandle(
    accountId: string,
    raw: string,
  ): Promise<{ handle: string; available: boolean; reason?: HandleRejection }> {
    const handle = normalizeHandle(raw);
    const shape = checkHandleShape(handle);
    if (shape) return { handle, available: false, reason: shape };

    const taken = await this.handleTaken(handle, accountId);
    return taken
      ? { handle, available: false, reason: 'taken' }
      : { handle, available: true };
  }

  /**
   * The name this account is publicly known by. A shop owner is known by
   * their storefront: one identity per person, whichever side of the platform
   * they are standing on, and it does not change because they also buy from
   * other shops. Only accounts without a shop carry a username of their own.
   */
  private async publicHandle(
    account: UserRow,
  ): Promise<{ handle: string | null; fromShop: boolean }> {
    const shop = await this.db.query.shops.findFirst({
      where: eq(shops.ownerId, account.id),
      columns: { handle: true },
    });
    return shop
      ? { handle: shop.handle, fromShop: true }
      : { handle: account.handle, fromShop: false };
  }

  /**
   * Claim (or change) the account's username. Gated on a verified email so a
   * name can always be traced back to a reachable account - that is what stops
   * handle-squatting with throwaway signups.
   */
  async setHandle(accountId: string, raw: string): Promise<BuyerProfile> {
    const account = await this.findById(accountId);
    if (!account) throw new UnauthorizedException('Account no longer exists');
    if (!account.emailVerified) {
      throw new ForbiddenException('Verify your email before setting a username');
    }
    // A seller already has a public name - the one over their shop.
    if ((await this.publicHandle(account)).fromShop) {
      throw new ConflictException('shop_handle');
    }

    const handle = normalizeHandle(raw);
    const shape = checkHandleShape(handle);
    if (shape) throw new ConflictException(shape);
    // A name someone else already publishes as is off limits, and so is one
    // the blocked-word list would reject anywhere else on the platform.
    if (await this.handleTaken(handle, accountId)) {
      throw new ConflictException('taken');
    }
    await this.blockedWords.assertClean(handle);

    const [row] = await this.db
      .update(users)
      .set({ handle })
      .where(eq(users.id, accountId))
      .returning();
    if (!row) throw new UnauthorizedException('Account no longer exists');
    return this.me(row);
  }

  /**
   * Taken by another account, or by a shop this account does not own - a
   * storefront's handle is a public identity on the same platform, so letting
   * a stranger claim it as a username would be an impersonation vector.
   */
  private async handleTaken(
    handle: string,
    accountId: string,
  ): Promise<boolean> {
    const [byAccount, byShop] = await Promise.all([
      this.db.query.users.findFirst({
        where: eq(users.handle, handle),
        columns: { id: true },
      }),
      this.db.query.shops.findFirst({
        where: eq(shops.handle, handle),
        columns: { ownerId: true },
      }),
    ]);
    if (byAccount && byAccount.id !== accountId) return true;
    if (byShop && byShop.ownerId !== accountId) return true;
    return false;
  }

  /**
   * Everything the account's storefront profile screen needs in one round-trip:
   * account info, headline stats, the orders placed with this email (matched
   * case-insensitively, the same link used to verify purchases) and reviews.
   */
  async overview(accountId: string): Promise<BuyerOverview> {
    const account = await this.findById(accountId);
    if (!account) throw new UnauthorizedException('Account no longer exists');

    const [orderRows, reviewRows] = await Promise.all([
      this.db.query.orders.findMany({
        // No email → match nothing (a phone-only account has no order history yet).
        where: account.email
          ? sql`lower(${orders.email}) = ${account.email.toLowerCase()}`
          : sql`false`,
        orderBy: [desc(orders.placedAt)],
        with: {
          shop: { columns: { name: true, handle: true } },
          items: { columns: { name: true, productId: true } },
          adjustments: true,
        },
      }),
      this.db.query.reviews.findMany({
        where: eq(reviews.buyerId, accountId),
        orderBy: [desc(reviews.createdAt)],
        with: {
          product: {
            columns: { name: true, slug: true },
            with: { shop: { columns: { handle: true, name: true } } },
          },
        },
      }),
    ]);

    const totalSpentCents = orderRows
      .filter((o) => o.pay === 'Paid')
      .reduce((sum, o) => sum + o.totalCents, 0);

    return {
      buyer: {
        ...(await this.me(account)),
        memberSince: account.createdAt.toISOString(),
      },
      stats: {
        orders: orderRows.length,
        reviews: reviewRows.length,
        totalSpent: centsToDollars(totalSpentCents),
      },
      orders: orderRows.map((o) => {
        const pending = o.adjustments.find((a) => a.status === 'pending');
        return {
          reference: o.reference,
          shopId: o.shopId,
          shopName: o.shop?.name ?? 'Shop',
          shopHandle: o.shop?.handle ?? '',
          itemSummary: summarizeItems(productLines(o.items).map((i) => i.name)),
          qty: o.qty,
          total: centsToDollars(o.totalCents),
          status: o.status,
          pay: o.pay,
          placedAt: o.placedAt.toISOString(),
          pendingAdjustment: pending
            ? {
                id: pending.id,
                previousTotal: centsToDollars(pending.previousTotalCents),
                newTotal: centsToDollars(pending.newTotalCents),
                reason: pending.reason,
                createdAt: pending.createdAt.toISOString(),
              }
            : null,
        };
      }),
      reviews: reviewRows.map((r) => ({
        id: r.id,
        rating: r.rating,
        body: r.body,
        imageUrl: r.imageUrl,
        createdAt: r.createdAt.toISOString(),
        productName: r.product?.name ?? 'Product',
        productSlug: r.product?.slug ?? '',
        shopHandle: r.product?.shop?.handle ?? '',
        shopName: r.product?.shop?.name ?? '',
      })),
    };
  }

  /**
   * Mint the account session token (same token the seller sign-in issues, at
   * the scope the account has earned). An account created inline at checkout
   * has verified nothing, so it gets a `storefront` session: enough to shop,
   * review and chat, refused on the seller-side API until a contact detail is
   * proved. See {@link SessionScopeService}.
   */
  private async issue(row: UserRow): Promise<BuyerAuthResponse> {
    const token = await this.tokens.signSellerToken(
      {
        sub: row.id,
        email: row.email ?? undefined,
        name: row.name,
        isAdmin: row.isAdmin,
      },
      await this.sessionScope.resolve(row),
    );
    return BuyerAuthResponse.of(row, token);
  }
}

/** "Mango Pickle +2 more" - a compact one-line summary of an order's items. */
function summarizeItems(names: string[]): string {
  if (!names.length) return '';
  const [first, ...rest] = names;
  return rest.length ? `${first} +${rest.length} more` : first;
}
