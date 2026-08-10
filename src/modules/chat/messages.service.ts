import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import {
  chatConversations,
  chatParticipants,
  chatMessages,
  orders,
  products,
  shops,
  type ChatAdjustmentSnapshotValue,
  type ChatOfferSnapshotValue,
  type ChatMessageRow,
  type ChatMessageStatus,
  type ChatMessageType,
  type ChatOrderSnapshotValue,
  type ChatProductSnapshotValue,
  type ChatSenderRole,
} from '../../database/schema';
import { centsToDollars } from '../../common/utils/money.util';
import { productLines } from '../../common/utils/order-line.util';
import type { ChatActor } from './chat-actor';
import { BotReplyService } from './bot-reply.service';
import { ChatRealtimeService } from './chat-realtime.service';
import { pairKeyFor, type ChatParty } from './chat-parties';
import {
  bumpUnreadForOthers,
  clearUnreadFor,
  sideOf,
} from './participant-unread.util';
import {
  buyerShopParties,
  writeThreadParticipants,
} from './thread-participants.util';
import { ConversationsService } from './conversations.service';
import type { MarkReadDto, SendMessageDto } from './dto/chat.dto';

const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

/**
 * Attachment allow-lists. Data URLs are echoed back to the counterpart's
 * browser, so only inert renderable/downloadable types are accepted - never
 * text/html, SVG (scriptable) or other active content.
 */
const IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
]);
const FILE_MIMES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'text/csv',
  'application/zip',
]);

export interface MessageDto {
  id: string;
  conversationId: string;
  senderId: string;
  senderRole: ChatSenderRole;
  type: string;
  text?: string;
  product?: ChatProductSnapshotValue;
  order?: ChatOrderSnapshotValue;
  adjustment?: ChatAdjustmentSnapshotValue;
  offer?: ChatOfferSnapshotValue;
  attachment?: {
    kind: 'image' | 'file';
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    dataUrl: string;
  };
  status: ChatMessageStatus;
  sentAt: string;
  /** Echoed from SendMessageDto for optimistic-UI reconciliation (not stored). */
  clientRef?: string;
}

@Injectable()
export class MessagesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly conversations: ConversationsService,
    private readonly realtime: ChatRealtimeService,
    private readonly botReply: BotReplyService,
  ) {}

  /** Page backwards through a thread (newest page first, items ascending). */
  async list(
    actor: ChatActor,
    conversationId: string,
    opts: { cursor?: string; limit?: number },
  ): Promise<{ items: MessageDto[]; nextCursor?: string }> {
    await this.conversations.requireParticipantRow(actor, conversationId);
    const limit = opts.limit ?? 40;

    let beforeFilter: SQL | undefined;
    if (opts.cursor) {
      const anchor = await this.db.query.chatMessages.findFirst({
        where: and(
          eq(chatMessages.id, opts.cursor),
          eq(chatMessages.conversationId, conversationId),
        ),
      });
      if (!anchor) throw new BadRequestException('Unknown cursor');
      // Compare against the stored value, not the JS Date - Postgres keeps
      // microseconds that a Date round-trip truncates away.
      beforeFilter = sql`${chatMessages.sentAt} < (select m.sent_at from chat_messages m where m.id = ${anchor.id})`;
    }

    const rows = await this.db.query.chatMessages.findMany({
      where: and(eq(chatMessages.conversationId, conversationId), beforeFilter),
      orderBy: [desc(chatMessages.sentAt), desc(chatMessages.id)],
      limit: limit + 1,
    });

    const page = rows.slice(0, limit).reverse();
    return {
      items: page.map((r) => this.toDto(r)),
      nextCursor: rows.length > limit ? page[0]?.id : undefined,
    };
  }

  /**
   * Validate, snapshot, persist and fan out one message. Unread counts and
   * the sidebar preview are updated in the same transaction as the insert.
   */
  async send(
    actor: ChatActor,
    conversationId: string,
    dto: SendMessageDto,
  ): Promise<MessageDto> {
    const convo = await this.conversations.requireParticipantRow(
      actor,
      conversationId,
    );

    const senderRole: ChatSenderRole =
      actor.role === 'customer' ? 'customer' : 'seller';
    const counterpartOnline =
      senderRole === 'customer'
        ? this.realtime.isOnline('shop', convo.shopId)
        : this.realtime.isOnline('buyer', convo.buyerId);

    const fields = await this.buildTypedFields(dto, convo);
    const preview = this.previewOf(dto.type, fields);

    const senderParties = await this.conversations.partySetFor(actor);
    const row = await this.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(chatMessages)
        .values({
          conversationId,
          senderRole,
          senderId: actor.id,
          type: dto.type,
          status: counterpartOnline ? 'delivered' : 'sent',
          deliveredAt: counterpartOnline ? new Date() : null,
          ...fields,
        })
        .returning();
      await tx
        .update(chatConversations)
        .set({
          lastMessageAt: inserted.sentAt,
          lastMessagePreview: {
            type: dto.type,
            text: preview,
            senderRole,
            sentAt: inserted.sentAt.toISOString(),
          },
          ...(senderRole === 'customer'
            ? { sellerUnread: sql`${chatConversations.sellerUnread} + 1` }
            : { buyerUnread: sql`${chatConversations.buyerUnread} + 1` }),
        })
        .where(eq(chatConversations.id, conversationId));

      // The counters above answer "unread for the buyer / for the shop", which
      // cannot say whose number it is once one person is both. Count it
      // against the side that did not send instead.
      // Resolved from every party this viewer speaks as, not from their role:
      // an owner replying in the console may be the *account* side of the
      // thread, not the shop.
      const mine = await sideOf(tx, conversationId, senderParties);
      if (mine) await bumpUnreadForOthers(tx, conversationId, mine.side);
      return inserted;
    });

    const message = { ...this.toDto(row), clientRef: dto.clientRef };
    // To both participants' rooms, whoever they are - the pair is what the
    // thread has, and buyer/shop is only one shape of it.
    for (const room of await this.threadRooms(conversationId, convo)) {
      this.realtime.emitTo(room, 'message.new', { conversationId, message });
    }
    await this.conversations.broadcastUpdated(conversationId);

    // AI auto-reply, when the shop has it switched on. Deliberately not
    // awaited: the customer's message is already committed and about to be
    // returned, and a model round trip takes seconds. The bot answers text
    // only - it has nothing useful to say to an image, an offer or an order
    // card, and the agent's API takes a string.
    if (senderRole === 'customer' && dto.type === 'text' && fields.text) {
      this.botReply.maybeReply(convo, fields.text);
    }

    return message;
  }

  /** Mark counterpart messages read up to (and including) one message. */
  async markRead(
    actor: ChatActor,
    conversationId: string,
    dto: MarkReadDto,
  ): Promise<void> {
    const convo = await this.conversations.requireParticipantRow(
      actor,
      conversationId,
    );
    const upTo = await this.db.query.chatMessages.findFirst({
      where: and(
        eq(chatMessages.id, dto.upToMessageId),
        eq(chatMessages.conversationId, conversationId),
      ),
    });
    if (!upTo) throw new NotFoundException('Message not found');

    const counterpart: ChatSenderRole =
      actor.role === 'customer' ? 'seller' : 'customer';
    const readerParties = await this.conversations.partySetFor(actor);
    await this.db.transaction(async (tx) => {
      await tx
        .update(chatMessages)
        .set({ status: 'read', readAt: new Date() })
        .where(
          and(
            eq(chatMessages.conversationId, conversationId),
            eq(chatMessages.senderRole, counterpart),
            // Subquery keeps Postgres's microsecond precision - a JS Date
            // round-trip truncates to ms and would miss the anchor message.
            sql`${chatMessages.sentAt} <= (select m.sent_at from chat_messages m where m.id = ${upTo.id})`,
            ne(chatMessages.status, 'read'),
          ),
        );
      await tx
        .update(chatConversations)
        .set(
          actor.role === 'customer' ? { buyerUnread: 0 } : { sellerUnread: 0 },
        )
        .where(eq(chatConversations.id, conversationId));

      // Clear the reader's own side, whichever of the two they are here.
      const mine = await sideOf(tx, conversationId, readerParties);
      if (mine) await clearUnreadFor(tx, conversationId, mine.side);
    });

    // Read receipt to the author's side; sidebar refresh to both.
    this.realtime.emitTo(
      counterpart === 'customer'
        ? ChatRealtimeService.room('buyer', convo.buyerId)
        : ChatRealtimeService.room('shop', convo.shopId),
      'message.status',
      { conversationId, status: 'read', upToMessageId: dto.upToMessageId },
    );
    await this.conversations.broadcastUpdated(conversationId);
  }

  /**
   * Flip this actor's pending incoming messages to `delivered` (called when
   * they connect) and notify each author's side.
   */
  /**
   * Rooms for both sides of a thread. Falls back to the buyer/shop columns for
   * threads written before participants existed.
   */
  private async threadRooms(
    conversationId: string,
    convo: { buyerId: string; shopId: string },
  ): Promise<string[]> {
    const sides = await this.db.query.chatParticipants.findMany({
      where: eq(chatParticipants.conversationId, conversationId),
      columns: { kind: true, accountId: true, shopId: true },
    });
    if (!sides.length) {
      return [
        ChatRealtimeService.room('buyer', convo.buyerId),
        ChatRealtimeService.room('shop', convo.shopId),
      ];
    }
    return [
      ...new Set(
        sides.map((s) =>
          ChatRealtimeService.partyRoom({
            kind: s.kind,
            id: s.kind === 'shop' ? s.shopId : s.accountId,
          }),
        ),
      ),
    ];
  }

  async markDeliveredOnConnect(actor: ChatActor): Promise<void> {
    const counterpart: ChatSenderRole =
      actor.role === 'customer' ? 'seller' : 'customer';
    const sideFilter =
      actor.role === 'customer'
        ? eq(chatConversations.buyerId, actor.id)
        : eq(chatConversations.shopId, actor.shopId);

    const pending = await this.db
      .update(chatMessages)
      .set({ status: 'delivered', deliveredAt: new Date() })
      .where(
        and(
          inArray(
            chatMessages.conversationId,
            this.db
              .select({ id: chatConversations.id })
              .from(chatConversations)
              .where(sideFilter),
          ),
          eq(chatMessages.senderRole, counterpart),
          eq(chatMessages.status, 'sent'),
        ),
      )
      .returning({ conversationId: chatMessages.conversationId });

    const convoIds = [...new Set(pending.map((p) => p.conversationId))];
    for (const conversationId of convoIds) {
      const convo = await this.db.query.chatConversations.findFirst({
        where: eq(chatConversations.id, conversationId),
      });
      if (!convo) continue;
      this.realtime.emitTo(
        counterpart === 'customer'
          ? ChatRealtimeService.room('buyer', convo.buyerId)
          : ChatRealtimeService.room('shop', convo.shopId),
        'message.status',
        { conversationId, status: 'delivered' },
      );
    }
  }

  /* ---------- helpers ---------- */

  /** Resolve + validate the type-specific payload, building snapshots. */
  private async buildTypedFields(
    dto: SendMessageDto,
    convo: {
      shopId: string;
      buyer: { email: string | null };
      shop: { currency: string; handle: string };
    },
  ): Promise<Partial<typeof chatMessages.$inferInsert>> {
    switch (dto.type) {
      case 'text': {
        if (!dto.text?.trim()) {
          throw new BadRequestException('Text messages need text');
        }
        return { text: dto.text.trim() };
      }
      case 'product': {
        if (!dto.productId) {
          throw new BadRequestException('productId is required');
        }
        const p = await this.db.query.products.findFirst({
          where: and(
            eq(products.id, dto.productId),
            eq(products.shopId, convo.shopId),
          ),
        });
        if (!p) {
          throw new NotFoundException(
            "Product not found in this shop's catalogue",
          );
        }
        const snapshot: ChatProductSnapshotValue = {
          productId: p.id,
          shopId: p.shopId,
          name: p.name,
          slug: p.slug,
          price: centsToDollars(p.priceCents),
          currency: convo.shop.currency,
          unit: p.unit,
          emoji: p.emoji,
          tone: p.tone,
          imageUrl: p.images?.[0],
        };
        return { product: snapshot, text: dto.text?.trim() || null };
      }
      case 'order': {
        if (!dto.orderId) {
          throw new BadRequestException('orderId is required');
        }
        // The order must belong to this shop AND to this conversation's buyer
        // (matched by checkout email), whichever side references it.
        const o = await this.db.query.orders.findFirst({
          where: and(
            eq(orders.id, dto.orderId),
            eq(orders.shopId, convo.shopId),
            sql`lower(${orders.email}) = ${(convo.buyer.email ?? '').toLowerCase()}`,
          ),
          with: { items: true },
        });
        if (!o) {
          throw new NotFoundException('Order not found in this conversation');
        }
        const snapshot: ChatOrderSnapshotValue = {
          orderId: o.id,
          displayId: o.reference,
          itemsSummary:
            productLines(o.items)
              .map((i) => `${i.name} ×${i.qty}`)
              .join(', ') || `${o.qty} item${o.qty === 1 ? '' : 's'}`,
          total: centsToDollars(o.totalCents),
          currency: convo.shop.currency,
          status: o.status,
        };
        return { order: snapshot, text: dto.text?.trim() || null };
      }
      case 'image':
      case 'file': {
        const a = dto.attachment;
        if (!a || a.kind !== dto.type) {
          throw new BadRequestException(
            'Attachment payload missing or mismatched',
          );
        }
        const mime = a.mimeType.toLowerCase();
        const allowed = dto.type === 'image' ? IMAGE_MIMES : FILE_MIMES;
        if (!allowed.has(mime)) {
          throw new BadRequestException(
            `Attachment type ${a.mimeType} is not allowed`,
          );
        }
        // The data URL must be plain base64 of exactly the declared type -
        // a mismatched or non-base64 payload is rejected outright.
        const prefix = `data:${mime};base64,`;
        if (!a.dataUrl.toLowerCase().startsWith(prefix)) {
          throw new BadRequestException(
            'Attachment data does not match its declared type',
          );
        }
        // Size is derived server-side; the client-sent figure is display-only.
        const sizeBytes = Math.floor(
          ((a.dataUrl.length - prefix.length) * 3) / 4,
        );
        const cap = dto.type === 'image' ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
        if (sizeBytes <= 0 || sizeBytes > cap) {
          throw new BadRequestException('Attachment too large or empty');
        }
        return {
          attachment: { ...a, mimeType: mime, sizeBytes },
          text: dto.text?.trim() || null,
        };
      }
      default:
        throw new BadRequestException('Unsupported message type');
    }
  }

  /** Sidebar snippet, mirroring the design reference's previewOf(). */
  private previewOf(
    type: string,
    fields: Partial<typeof chatMessages.$inferInsert>,
  ): string {
    switch (type) {
      case 'text':
        return (fields.text ?? '').slice(0, 140);
      case 'product':
        return `📦 ${fields.product?.name ?? 'Product'}`;
      case 'order':
        return `🧾 Order ${fields.order?.displayId ?? ''}`.trim();
      case 'image':
        return '🖼️ Photo';
      case 'file':
        return `📎 ${fields.attachment?.fileName ?? 'File'}`;
      case 'adjustment':
        return `💱 Order ${fields.adjustment?.displayId ?? ''} amount change`.trim();
      case 'offer':
        return `🧾 ${fields.offer?.itemsSummary ?? 'Order offer'}`;
      default:
        return '';
    }
  }

  /**
   * Post a shop-initiated message into the (buyer, shop) thread on the
   * platform's behalf - used for order-amount change cards, not a live seller.
   * Creates the thread if it doesn't exist. The bubble reads as from the shop
   * (senderRole 'seller', senderId = the shop's owner account).
   */
  async postShopMessage(
    shopId: string,
    buyerAccountId: string,
    payload: {
      type: ChatMessageType;
      text?: string;
      adjustment?: ChatAdjustmentSnapshotValue;
      offer?: ChatOfferSnapshotValue;
    },
  ): Promise<void> {
    const parties = buyerShopParties(buyerAccountId, shopId);
    await this.db
      .insert(chatConversations)
      .values({
        buyerId: buyerAccountId,
        shopId,
        pairKey: pairKeyFor(parties[0], parties[1]),
      })
      .onConflictDoNothing({
        target: [chatConversations.buyerId, chatConversations.shopId],
      });
    const convo = await this.db.query.chatConversations.findFirst({
      where: and(
        eq(chatConversations.buyerId, buyerAccountId),
        eq(chatConversations.shopId, shopId),
      ),
    });
    if (!convo) return;
    await writeThreadParticipants(this.db, convo.id, parties[0], parties[1]);
    const shop = await this.db.query.shops.findFirst({
      where: eq(shops.id, shopId),
      columns: { ownerId: true },
    });
    const senderId = shop?.ownerId ?? buyerAccountId;
    const fields = {
      text: payload.text ?? null,
      adjustment: payload.adjustment ?? null,
      offer: payload.offer ?? null,
    };
    const preview = this.previewOf(payload.type, fields);
    const buyerOnline = this.realtime.isOnline('buyer', buyerAccountId);

    const row = await this.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(chatMessages)
        .values({
          conversationId: convo.id,
          senderRole: 'seller',
          senderId,
          type: payload.type,
          status: buyerOnline ? 'delivered' : 'sent',
          deliveredAt: buyerOnline ? new Date() : null,
          ...fields,
        })
        .returning();
      await tx
        .update(chatConversations)
        .set({
          lastMessageAt: inserted.sentAt,
          lastMessagePreview: {
            type: payload.type,
            text: preview,
            senderRole: 'seller',
            sentAt: inserted.sentAt.toISOString(),
          },
          buyerUnread: sql`${chatConversations.buyerUnread} + 1`,
        })
        .where(eq(chatConversations.id, convo.id));
      return inserted;
    });

    const message = this.toDto(row);
    this.realtime.emitTo(
      ChatRealtimeService.room('buyer', buyerAccountId),
      'message.new',
      { conversationId: convo.id, message },
    );
    this.realtime.emitTo(
      ChatRealtimeService.room('shop', shopId),
      'message.new',
      { conversationId: convo.id, message },
    );
    await this.conversations.broadcastUpdated(convo.id);
  }

  /**
   * Reflect a resolved adjustment onto its card so a later reload shows the
   * outcome (the live confirmation is the follow-up message posted alongside).
   */
  async updateAdjustmentStatus(
    adjustmentId: string,
    status: ChatAdjustmentSnapshotValue['status'],
  ): Promise<void> {
    await this.db
      .update(chatMessages)
      .set({
        adjustment: sql`jsonb_set(${chatMessages.adjustment}, '{status}', ${JSON.stringify(
          status,
        )}::jsonb, false)`,
      })
      .where(
        and(
          eq(chatMessages.type, 'adjustment'),
          sql`${chatMessages.adjustment}->>'adjustmentId' = ${adjustmentId}`,
        ),
      );
  }

  /**
   * Reflect an offer's outcome onto its card, so reopening the thread shows
   * "Accepted"/"Rejected" rather than live buttons. Mirrors
   * {@link updateAdjustmentStatus}.
   */
  async updateOfferStatus(
    offerId: string,
    status: ChatOfferSnapshotValue['status'],
  ): Promise<void> {
    await this.db
      .update(chatMessages)
      .set({
        offer: sql`jsonb_set(${chatMessages.offer}, '{status}', ${JSON.stringify(
          status,
        )}::jsonb, false)`,
      })
      .where(
        and(
          eq(chatMessages.type, 'offer'),
          sql`${chatMessages.offer}->>'offerId' = ${offerId}`,
        ),
      );
  }

  private toDto(row: ChatMessageRow): MessageDto {
    return {
      id: row.id,
      conversationId: row.conversationId,
      senderId: row.senderId,
      senderRole: row.senderRole,
      type: row.type,
      text: row.text ?? undefined,
      product: row.product ?? undefined,
      order: row.order ?? undefined,
      adjustment: row.adjustment ?? undefined,
      offer: row.offer ?? undefined,
      attachment: row.attachment ?? undefined,
      status: row.status,
      sentAt: row.sentAt.toISOString(),
    };
  }
}
