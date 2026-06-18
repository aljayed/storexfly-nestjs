import {
  ConflictException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
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
import type {
  BuyerOverview,
  BuyerProfile,
  UpdateBuyerProfileDto,
} from './dto/buyer-overview.dto';

const BCRYPT_ROUNDS = 10;

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

  async register(dto: BuyerRegisterDto): Promise<BuyerAuthResponse> {
    if (await this.findByEmail(dto.email)) {
      throw new ConflictException('An account with this email already exists');
    }
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    const [row] = await this.db
      .insert(buyers)
      .values({ name: dto.name, email: dto.email, passwordHash })
      .returning();
    return this.issue(row);
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
    if (dto.phone !== undefined) patch.phone = dto.phone || null;
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
