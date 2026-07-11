import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import * as bcrypt from 'bcryptjs';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import {
  buyers,
  orders,
  reviews,
  type BuyerRow,
  type NewBuyerRow,
} from '../../database/schema';
import { centsToDollars } from '../../common/utils/money.util';
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

const BCRYPT_ROUNDS = 10;

/** Reduce any BD phone format to the bare 10-digit national number, so numbers
 *  captured as "+8801712…", "01712…" or "1712…" all compare equal. */
function normalizePhone(raw: string | null | undefined): string {
  return (raw ?? '')
    .replace(/\D/g, '')
    .replace(/^880/, '')
    .replace(/^0+/, '');
}

/** Buyer accounts: email register/login, used to gate verified-purchase reviews. */
@Injectable()
export class BuyerService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly tokens: TokenService,
  ) {}

  async findById(id: string): Promise<BuyerRow | undefined> {
    return this.db.query.buyers.findFirst({ where: eq(buyers.id, id) });
  }

  private async findByEmail(email: string): Promise<BuyerRow | undefined> {
    return this.db.query.buyers.findFirst({ where: eq(buyers.email, email) });
  }

  /** Look up a buyer by their normalized (national 10-digit) phone number. */
  private async findByPhone(phone: string): Promise<BuyerRow | undefined> {
    const normalized = normalizePhone(phone);
    if (!normalized) return undefined;
    return this.db.query.buyers.findFirst({
      where: eq(buyers.phone, normalized),
    });
  }

  async register(dto: BuyerRegisterDto): Promise<BuyerAuthResponse> {
    if (await this.findByEmail(dto.email)) {
      throw new ConflictException({
        code: 'EMAIL_TAKEN',
        message: 'An account with this email already exists',
      });
    }
    // One account per phone number. Checked before insert so the buyer gets a
    // clear "this phone already has an account" message (and a sign-in path).
    const phone = dto.phone ? normalizePhone(dto.phone) : null;
    if (phone && (await this.findByPhone(phone))) {
      throw new ConflictException({
        code: 'PHONE_TAKEN',
        message: 'This phone number is already associated with another account',
      });
    }
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    const [row] = await this.db
      .insert(buyers)
      .values({
        name: dto.name,
        email: dto.email,
        passwordHash,
        // Seed the saved checkout details captured at inline checkout.
        phone,
        addressLine: dto.address || null,
        addressCity: dto.city || null,
        addressPincode: dto.pincode || null,
        geo: dto.geo ?? null,
      })
      .returning();
    return this.issue(row);
  }

  /**
   * Link a guest order to the signed-in buyer after they could not auto-create
   * an account (the order's phone already belonged to this account). Proof of
   * ownership is the phone match: the order was placed with the same number
   * saved on this account. Linking rewrites the order's email to the buyer's,
   * which is the key order history and verified-purchase reviews match on.
   */
  async claimOrder(
    buyerId: string,
    dto: ClaimOrderDto,
  ): Promise<{ linked: boolean }> {
    const buyer = await this.findById(buyerId);
    if (!buyer) throw new UnauthorizedException('Account no longer exists');

    const order = await this.db.query.orders.findFirst({
      where: and(
        eq(orders.shopId, dto.shopId),
        eq(orders.reference, dto.reference),
      ),
    });
    if (!order) throw new NotFoundException('Order not found');

    // Already linked (e.g. the order email already matches) — idempotent.
    if (order.email === buyer.email) return { linked: true };

    if (
      !buyer.phone ||
      normalizePhone(order.phone) !== normalizePhone(buyer.phone)
    ) {
      throw new ForbiddenException(
        'This order cannot be linked to your account',
      );
    }

    await this.db
      .update(orders)
      .set({ email: buyer.email })
      .where(eq(orders.id, order.id));
    return { linked: true };
  }

  async login(dto: BuyerLoginDto): Promise<BuyerAuthResponse> {
    const row = await this.findByEmail(dto.email);
    if (!row || !(await bcrypt.compare(dto.password, row.passwordHash))) {
      throw new UnauthorizedException('Invalid email or password');
    }
    return this.issue(row);
  }

  me(row: BuyerRow): BuyerProfile {
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      phone: row.phone,
      address: row.addressLine,
      city: row.addressCity,
      pincode: row.addressPincode,
      geo: row.geo,
    };
  }

  /**
   * Update the buyer's editable account fields (display name plus the saved
   * checkout details used to autofill the order form). Only the keys present in
   * the DTO are written, so a partial PATCH never clears untouched fields.
   */
  async updateProfile(
    buyerId: string,
    dto: UpdateBuyerProfileDto,
  ): Promise<BuyerProfile> {
    const patch: Partial<NewBuyerRow> = {};
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.phone !== undefined) patch.phone = normalizePhone(dto.phone) || null;
    if (dto.address !== undefined) patch.addressLine = dto.address || null;
    if (dto.city !== undefined) patch.addressCity = dto.city || null;
    if (dto.pincode !== undefined) patch.addressPincode = dto.pincode || null;
    if (dto.geo !== undefined) patch.geo = dto.geo ?? null;

    const [row] = await this.db
      .update(buyers)
      .set(patch)
      .where(eq(buyers.id, buyerId))
      .returning();
    if (!row) throw new UnauthorizedException('Account no longer exists');
    return this.me(row);
  }

  /**
   * Everything the buyer profile screen needs in one round-trip: account info,
   * headline stats, the buyer's orders (matched by email, the same link used to
   * verify purchases) and the reviews they've written.
   */
  async overview(buyerId: string): Promise<BuyerOverview> {
    const buyer = await this.findById(buyerId);
    if (!buyer) throw new UnauthorizedException('Account no longer exists');

    const [orderRows, reviewRows] = await Promise.all([
      this.db.query.orders.findMany({
        where: eq(orders.email, buyer.email),
        orderBy: [desc(orders.placedAt)],
        with: {
          shop: { columns: { name: true, handle: true } },
          items: { columns: { name: true } },
        },
      }),
      this.db.query.reviews.findMany({
        where: eq(reviews.buyerId, buyerId),
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
        id: buyer.id,
        name: buyer.name,
        email: buyer.email,
        phone: buyer.phone,
        address: buyer.addressLine,
        city: buyer.addressCity,
        pincode: buyer.addressPincode,
        geo: buyer.geo,
        memberSince: buyer.createdAt.toISOString(),
      },
      stats: {
        orders: orderRows.length,
        reviews: reviewRows.length,
        totalSpent: centsToDollars(totalSpentCents),
      },
      orders: orderRows.map((o) => ({
        reference: o.reference,
        shopName: o.shop?.name ?? 'Shop',
        shopHandle: o.shop?.handle ?? '',
        itemSummary: summarizeItems(o.items.map((i) => i.name)),
        qty: o.qty,
        total: centsToDollars(o.totalCents),
        status: o.status,
        pay: o.pay,
        placedAt: o.placedAt.toISOString(),
      })),
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

  private async issue(row: BuyerRow): Promise<BuyerAuthResponse> {
    const token = await this.tokens.signBuyerToken({
      sub: row.id,
      email: row.email,
      name: row.name,
    });
    return BuyerAuthResponse.of(row, token);
  }
}

/** "Mango Pickle +2 more" — a compact one-line summary of an order's items. */
function summarizeItems(names: string[]): string {
  if (!names.length) return '';
  const [first, ...rest] = names;
  return rest.length ? `${first} +${rest.length} more` : first;
}
