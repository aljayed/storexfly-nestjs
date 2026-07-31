import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, or, sql } from 'drizzle-orm';
import { dollarsToCents } from '../../common/utils/money.util';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import {
  chatConversations,
  chatOrderOffers,
  orders,
  products,
  shops,
  users,
  type ChatOfferItemValue,
  type ChatOrderOfferRow,
} from '../../database/schema';
import type { CustomerActor, SellerActor } from '../chat/chat-actor';
import { MessagesService } from '../chat/messages.service';
import { OrdersService } from '../orders/orders.service';
import {
  CreateOfferDto,
  OfferResponse,
  RespondOfferDto,
  StartWithCustomerDto,
} from './dto/offer.dto';

/** Reduce any BD phone format to the bare national number. */
function normalizePhone(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\D/g, '').replace(/^880/, '').replace(/^0+/, '');
}

/**
 * Order offers in chat, plus the seller-initiated thread lookup.
 *
 * Lives outside ChatModule on purpose. Chat is self-contained and depends on
 * no feature module (the dependency runs orders → chat, never the reverse);
 * this feature needs both chat and orders, so it sits above them rather than
 * inside either.
 */
@Injectable()
export class ChatOffersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly messages: MessagesService,
    private readonly orders: OrdersService,
  ) {}

  // ── Seller: start a thread from a phone number or email ──────────

  /**
   * Find the buyer account behind a phone/email so the seller can open a
   * thread with them.
   *
   * The match must be *verified* on the channel used — the same rule that
   * decides whether an order belongs to an account. Messaging whoever merely
   * typed an address at checkout would let a seller reach the wrong person,
   * and an unverified row is not evidence of ownership.
   *
   * A conversation also needs a real account: `chat_conversations.buyer_id` is
   * a FK to `users`, and the buyer has to sign in to read anything. So when
   * there's no account we say so plainly rather than inventing one — creating
   * shadow accounts from seller input would be both a privacy and an abuse
   * problem.
   */
  async startWithCustomer(
    actor: SellerActor,
    dto: StartWithCustomerDto,
  ): Promise<{
    found: boolean;
    conversationId?: string;
    buyerName?: string;
    reason?: 'no_input' | 'no_account' | 'no_account_but_customer';
    customerName?: string;
  }> {
    const phone = normalizePhone(dto.phone);
    const email = dto.email?.trim().toLowerCase() ?? '';
    if (!phone && !email) return { found: false, reason: 'no_input' };

    const candidates = await this.db.query.users.findMany({
      where: phone && email
        ? or(eq(users.phone, phone), eq(users.email, email))
        : phone
          ? eq(users.phone, phone)
          : eq(users.email, email),
      columns: {
        id: true,
        name: true,
        email: true,
        phone: true,
        emailVerified: true,
        phoneVerified: true,
      },
    });
    const match = candidates.find(
      (u) =>
        (!!email && u.emailVerified && u.email === email) ||
        (!!phone && u.phoneVerified && u.phone === phone),
    );

    if (!match) {
      // Distinguish "never heard of them" from "they've ordered from you but
      // have no account" — the second is worth telling the seller, because
      // the fix is to ask the buyer to sign up.
      const customer = await this.db.query.customers.findFirst({
        where: and(
          eq(sql`customers.shop_id`, actor.shopId),
          phone && email
            ? or(sql`customers.phone = ${phone}`, sql`lower(customers.email) = ${email}`)
            : phone
              ? sql`customers.phone = ${phone}`
              : sql`lower(customers.email) = ${email}`,
        ),
        columns: { name: true },
      });
      return customer
        ? { found: false, reason: 'no_account_but_customer', customerName: customer.name }
        : { found: false, reason: 'no_account' };
    }

    await this.db
      .insert(chatConversations)
      .values({ buyerId: match.id, shopId: actor.shopId })
      .onConflictDoNothing({
        target: [chatConversations.buyerId, chatConversations.shopId],
      });
    const convo = await this.db.query.chatConversations.findFirst({
      where: and(
        eq(chatConversations.buyerId, match.id),
        eq(chatConversations.shopId, actor.shopId),
      ),
      columns: { id: true },
    });
    return { found: true, conversationId: convo?.id, buyerName: match.name };
  }

  // ── Seller: compose an offer ─────────────────────────────────────

  async create(
    actor: SellerActor,
    conversationId: string,
    dto: CreateOfferDto,
  ): Promise<OfferResponse> {
    const convo = await this.db.query.chatConversations.findFirst({
      where: eq(chatConversations.id, conversationId),
    });
    if (!convo) throw new NotFoundException('Conversation not found');
    if (convo.shopId !== actor.shopId) {
      throw new ForbiddenException('Not your conversation');
    }

    const ids = [...new Set(dto.items.map((i) => i.productId))];
    const rows = await this.db.query.products.findMany({
      where: and(
        sql`${products.id} = any(${sql.raw(`array[${ids.map((i) => `'${i}'`).join(',')}]::uuid[]`)})`,
        eq(products.shopId, actor.shopId),
      ),
    });
    const byId = new Map(rows.map((p) => [p.id, p]));

    const items: ChatOfferItemValue[] = [];
    for (const pick of dto.items) {
      const product = byId.get(pick.productId);
      if (!product) {
        throw new NotFoundException('One of those items is not in your shop');
      }
      // Showcase listings are advertised only and never sold through
      // checkout, so an offer for one could never be accepted.
      if (product.listingType !== 'sale') {
        throw new BadRequestException(
          `“${product.name}” is a showcase-only listing and can't be ordered online.`,
        );
      }
      const unitPriceCents =
        pick.unitPrice === undefined
          ? product.priceCents
          : dollarsToCents(pick.unitPrice);
      items.push({
        productId: product.id,
        name: product.name,
        qty: pick.qty,
        unitPriceCents,
        imageUrl: product.images?.[0],
        emoji: product.emoji,
        tone: product.tone,
        unit: product.unit,
      });
    }

    const itemsSubtotalCents = items.reduce(
      (s, i) => s + i.unitPriceCents * i.qty,
      0,
    );
    const deliveryCents = dto.delivery ? dollarsToCents(dto.delivery) : 0;
    const totalCents = itemsSubtotalCents + deliveryCents;
    if (totalCents <= 0) {
      throw new BadRequestException('An offer must come to more than 0');
    }

    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('The expiry must be in the future');
    }

    const [row] = await this.db
      .insert(chatOrderOffers)
      .values({
        conversationId,
        shopId: actor.shopId,
        buyerId: convo.buyerId,
        items,
        itemsSubtotalCents,
        deliveryCents,
        totalCents,
        note: dto.note?.trim() || null,
        expiresAt,
      })
      .returning();

    const shop = await this.shopMeta(actor.shopId);
    await this.messages.postShopMessage(actor.shopId, convo.buyerId, {
      type: 'offer',
      offer: {
        offerId: row.id,
        itemsSummary: this.summarize(items),
        itemCount: items.reduce((s, i) => s + i.qty, 0),
        total: row.totalCents / 100,
        currency: shop.currency,
        status: 'pending',
        expiresAt: expiresAt?.toISOString(),
        // The first line's cover fronts the card.
        imageUrl: items[0].imageUrl,
        emoji: items[0].emoji,
        tone: items[0].tone,
        delivery: row.deliveryCents / 100,
      },
    });

    return OfferResponse.from(row, {
      shopName: shop.name,
      currency: shop.currency,
    });
  }

  /** "2 × Alphonso Mango Box + 1 more" — the one-line bubble summary. */
  private summarize(items: ChatOfferItemValue[]): string {
    const first = items[0];
    const head = `${first.qty} × ${first.name}`;
    return items.length > 1 ? `${head} + ${items.length - 1} more` : head;
  }

  // ── Both sides: read one offer ───────────────────────────────────

  async getById(
    actor: CustomerActor | SellerActor,
    offerId: string,
  ): Promise<OfferResponse> {
    const row = await this.mustFind(offerId);
    await this.assertParticipant(actor, row);
    const shop = await this.shopMeta(row.shopId);
    let orderReference: string | undefined;
    if (row.orderId) {
      const order = await this.db.query.orders.findFirst({
        where: eq(orders.id, row.orderId),
        columns: { reference: true },
      });
      orderReference = order?.reference;
    }
    return OfferResponse.from(row, {
      shopName: shop.name,
      currency: shop.currency,
      orderReference,
    });
  }

  // ── Buyer: accept or reject ──────────────────────────────────────

  /**
   * Accepting places the order. The offer row is claimed with a conditional
   * update — `status = 'accepted' WHERE status = 'pending'` — so two taps, or
   * two devices, can never both win; the loser gets a clear conflict instead
   * of a duplicate order.
   */
  async respond(
    actor: CustomerActor,
    offerId: string,
    dto: RespondOfferDto,
  ): Promise<{ offer: OfferResponse; paymentUrl?: string; orderReference?: string }> {
    const row = await this.mustFind(offerId);
    if (row.buyerId !== actor.id) {
      throw new ForbiddenException('This offer is not addressed to you');
    }
    if (row.status !== 'pending') {
      throw new ConflictException('This offer has already been answered');
    }
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
      await this.settle(row.id, 'expired');
      throw new ConflictException('This offer has expired');
    }

    if (!dto.accept) {
      const updated = await this.settle(row.id, 'rejected');
      await this.messages.updateOfferStatus(row.id, 'rejected');
      const shop = await this.shopMeta(row.shopId);
      return {
        offer: OfferResponse.from(updated, {
          shopName: shop.name,
          currency: shop.currency,
        }),
      };
    }

    if (!dto.address?.line?.trim() || !dto.address?.area?.trim()) {
      throw new BadRequestException(
        'A delivery address is required to accept this offer.',
      );
    }
    if (!dto.paymentMethod) {
      throw new BadRequestException('Pick a payment method to accept.');
    }

    // Claim it before touching stock or money. If this returns nothing the
    // offer was answered a moment ago and we must not place a second order.
    const claimed = await this.db
      .update(chatOrderOffers)
      .set({ status: 'accepted', respondedAt: new Date() })
      .where(
        and(eq(chatOrderOffers.id, row.id), eq(chatOrderOffers.status, 'pending')),
      )
      .returning({ id: chatOrderOffers.id });
    if (!claimed.length) {
      throw new ConflictException('This offer has already been answered');
    }

    const buyer = await this.db.query.users.findFirst({
      where: eq(users.id, actor.id),
      columns: { id: true, name: true, email: true, phone: true },
    });
    if (!buyer) throw new NotFoundException('Account not found');

    let placed;
    try {
      placed = await this.orders.placeFromOffer({
        offer: {
          id: row.id,
          shopId: row.shopId,
          items: row.items,
          deliveryCents: row.deliveryCents,
          totalCents: row.totalCents,
        },
        buyer,
        address: {
          line: dto.address.line,
          area: dto.address.area,
          pincode: dto.address.pincode,
        },
        paymentMethod: dto.paymentMethod,
        phone: dto.phone,
      });
    } catch (err) {
      // Placing failed (stock gone, shop offline, gateway down). Hand the
      // offer back so the buyer can retry once the seller fixes it, rather
      // than burning it on an order that never existed.
      await this.db
        .update(chatOrderOffers)
        .set({ status: 'pending', respondedAt: null })
        .where(eq(chatOrderOffers.id, row.id));
      throw err;
    }

    const [updated] = await this.db
      .update(chatOrderOffers)
      .set({ orderId: placed.order.id })
      .where(eq(chatOrderOffers.id, row.id))
      .returning();

    await this.messages.updateOfferStatus(row.id, 'accepted');
    await this.messages.postShopMessage(row.shopId, row.buyerId, {
      type: 'system',
      text: `Offer accepted — order ${placed.order.reference} placed.`,
    });

    const shop = await this.shopMeta(row.shopId);
    return {
      offer: OfferResponse.from(updated, {
        shopName: shop.name,
        currency: shop.currency,
        orderReference: placed.order.reference,
      }),
      paymentUrl: placed.paymentUrl,
      orderReference: placed.order.reference,
    };
  }

  /** Seller pulls back an offer the buyer hasn't answered yet. */
  async withdraw(actor: SellerActor, offerId: string): Promise<OfferResponse> {
    const row = await this.mustFind(offerId);
    if (row.shopId !== actor.shopId) {
      throw new ForbiddenException('Not your offer');
    }
    if (row.status !== 'pending') {
      throw new ConflictException('Only a pending offer can be withdrawn');
    }
    const updated = await this.settle(row.id, 'withdrawn');
    await this.messages.updateOfferStatus(row.id, 'withdrawn');
    const shop = await this.shopMeta(row.shopId);
    return OfferResponse.from(updated, {
      shopName: shop.name,
      currency: shop.currency,
    });
  }

  // ── helpers ──────────────────────────────────────────────────────

  private async mustFind(offerId: string): Promise<ChatOrderOfferRow> {
    const row = await this.db.query.chatOrderOffers.findFirst({
      where: eq(chatOrderOffers.id, offerId),
    });
    if (!row) throw new NotFoundException('Offer not found');
    return row;
  }

  private async assertParticipant(
    actor: CustomerActor | SellerActor,
    row: ChatOrderOfferRow,
  ): Promise<void> {
    const ok =
      actor.role === 'seller'
        ? row.shopId === actor.shopId
        : row.buyerId === actor.id;
    if (!ok) throw new ForbiddenException('Not your offer');
  }

  private async settle(
    offerId: string,
    status: 'rejected' | 'withdrawn' | 'expired',
  ): Promise<ChatOrderOfferRow> {
    const [row] = await this.db
      .update(chatOrderOffers)
      .set({ status, respondedAt: new Date() })
      .where(eq(chatOrderOffers.id, offerId))
      .returning();
    return row;
  }

  private async shopMeta(
    shopId: string,
  ): Promise<{ name: string; currency: string }> {
    const shop = await this.db.query.shops.findFirst({
      where: eq(shops.id, shopId),
      columns: { name: true, currency: true },
    });
    return { name: shop?.name ?? '', currency: shop?.currency ?? 'BDT' };
  }
}
