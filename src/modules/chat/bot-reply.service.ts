import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import {
  adminUsers,
  chatConversations,
  chatMessages,
  chatParticipants,
  shops,
} from '../../database/schema';
import { ChatRealtimeService } from './chat-realtime.service';
import { ConversationsService } from './conversations.service';

/**
 * The bits of a conversation row this service needs. Structural rather than
 * the full row type, so it accepts whatever `requireParticipantRow` hands back
 * without this module caring about the rest of the schema.
 */
export interface BotConversation {
  id: string;
  shopId: string;
  buyerId: string;
  originType: string | null;
  originRefId: string | null;
}

/**
 * AI auto-reply for the seller inbox, gated on `shops.bot_chat_enabled`.
 *
 * The reply text comes from the shop customer agent - a separate FastAPI
 * service that answers from this shop's live catalog. This module only decides
 * *whether* to ask it and owns everything that lands in the database.
 *
 * ## Why the agent is called without `buyer_id`
 *
 * Sent a `buyer_id`, the agent persists the thread itself: it writes the
 * customer's message AND its reply into `chat_conversations` / `chat_messages`.
 * We have already written the customer's message by the time we get here, so
 * that path would duplicate it, and the second copy would arrive without a
 * realtime event or an unread update - a message the seller's inbox shows and
 * the buyer's does not.
 *
 * Calling it anonymously keeps exactly one writer (this module) and one source
 * of truth for delivery, unread counts and the websocket fan-out. The agent
 * still keeps conversation history: `session_id` is the conversation id, so a
 * thread's context survives across turns in the agent's own session store.
 *
 * ## Failure is never the customer's problem
 *
 * Every path here is best-effort. The customer's message is already committed
 * and acknowledged before this runs; a model timeout, a 429 or a dead service
 * must leave the thread exactly as if the bot were switched off.
 */
@Injectable()
export class BotReplyService {
  private readonly log = new Logger(BotReplyService.name);

  /** Same-network address of the agent. Empty disables auto-reply outright. */
  private readonly agentUrl = (
    process.env.CHAT_AGENT_URL ?? 'http://chat:8000'
  ).replace(/\/+$/, '');

  /**
   * Hard ceiling on one agent call. The agent's own model timeout sits below
   * this, so in practice it answers first; this only stops a wedged request
   * from holding a connection open forever.
   */
  private readonly timeoutMs = Number(
    process.env.CHAT_AGENT_TIMEOUT_MS ?? 45_000,
  );

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly realtime: ChatRealtimeService,
    private readonly conversations: ConversationsService,
  ) {}

  /**
   * Answer one customer message, if this shop has the bot switched on.
   *
   * Fire-and-forget: callers must not await this on the request path, and it
   * never throws.
   */
  maybeReply(convo: BotConversation, customerText: string): void {
    void this.reply(convo, customerText).catch((err) => {
      this.log.warn(
        `bot reply failed for conversation ${convo.id}: ${String(err)}`,
      );
    });
  }

  private async reply(
    convo: BotConversation,
    customerText: string,
  ): Promise<void> {
    if (!this.agentUrl) return;

    const shop = await this.db.query.shops.findFirst({
      where: eq(shops.id, convo.shopId),
      columns: { id: true, botChatEnabled: true, live: true },
    });
    if (!shop?.botChatEnabled) return;
    // The agent refuses a shop that isn't live anyway; skipping here saves the
    // round trip and keeps the reason in our logs rather than a 404 body.
    if (!shop.live) return;

    // Whoever the reply is attributed to has to be a real staff member of this
    // shop: `chat_messages.sender_id` is an admin-user id for seller messages,
    // and the console resolves the name and avatar from it. The owner is the
    // one admin row every shop is guaranteed to have.
    const owner = await this.db.query.adminUsers.findFirst({
      where: and(
        eq(adminUsers.shopId, convo.shopId),
        eq(adminUsers.role, 'owner'),
      ),
      columns: { id: true },
    });
    if (!owner) {
      this.log.warn(
        `shop ${convo.shopId} has no owner admin - skipping bot reply`,
      );
      return;
    }

    const answer = await this.ask(convo, customerText);
    if (!answer?.reply?.trim()) return;

    await this.post(convo, owner.id, answer.reply.trim(), answer.escalated);
  }

  /** One call to the agent. Returns null on any failure. */
  private async ask(
    convo: BotConversation,
    message: string,
  ): Promise<{ reply: string; escalated: boolean } | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.agentUrl}/api/v1/chat/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          shop_id: convo.shopId,
          message,
          // The conversation id doubles as the agent's session key, so a
          // thread keeps its history across turns without us replaying it.
          session_id: convo.id,
          // Per-message page context for threads opened from a product page.
          // Order origins are deliberately not passed: this agent is link-only
          // and cannot look up an order, so it would only invite a question it
          // has to escalate.
          ...(convo.originType === 'product' && convo.originRefId
            ? { product_id: convo.originRefId }
            : {}),
        }),
      });

      if (!res.ok) {
        this.log.warn(`agent returned ${res.status} for shop ${convo.shopId}`);
        return null;
      }
      const body = (await res.json()) as {
        reply?: string;
        escalated_to_human?: boolean;
      };
      return {
        reply: body.reply ?? '',
        escalated: Boolean(body.escalated_to_human),
      };
    } catch (err) {
      this.log.warn(
        `agent call failed for shop ${convo.shopId}: ${String(err)}`,
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Persist the reply as an ordinary seller message and fan it out, so it is
   * indistinguishable downstream from one a human typed.
   */
  private async post(
    convo: BotConversation,
    senderId: string,
    text: string,
    escalated: boolean,
  ): Promise<void> {
    const buyerOnline = this.realtime.isOnline('buyer', convo.buyerId);

    const row = await this.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(chatMessages)
        .values({
          conversationId: convo.id,
          senderRole: 'seller',
          senderId,
          senderSide: 'b',
          type: 'text',
          text,
          status: buyerOnline ? 'delivered' : 'sent',
          deliveredAt: buyerOnline ? new Date() : null,
        })
        .returning();

      await tx
        .update(chatConversations)
        .set({
          lastMessageAt: inserted.sentAt,
          lastMessagePreview: {
            type: 'text',
            text,
            senderRole: 'seller',
            senderSide: 'b',
            sentAt: inserted.sentAt.toISOString(),
          },
          buyerUnread: sql`${chatConversations.buyerUnread} + 1`,
          // The point of the toggle is that a handled question stops nagging
          // the seller, so take back the unread the customer's message just
          // added - but only when the bot actually handled it. An escalation
          // is the agent saying a human is needed, and clearing the badge
          // there would bury the one thread that wants attention.
          //
          // Decremented rather than zeroed: earlier messages the seller has
          // genuinely not read are not this reply's to dismiss.
          ...(escalated
            ? {}
            : {
                sellerUnread: sql`GREATEST(${chatConversations.sellerUnread} - 1, 0)`,
              }),
        })
        .where(eq(chatConversations.id, convo.id));

      await tx
        .update(chatParticipants)
        .set({ unread: sql`${chatParticipants.unread} + 1` })
        .where(
          and(
            eq(chatParticipants.conversationId, convo.id),
            eq(chatParticipants.side, 'a'),
          ),
        );
      if (!escalated) {
        await tx
          .update(chatParticipants)
          .set({ unread: sql`GREATEST(${chatParticipants.unread} - 1, 0)` })
          .where(
            and(
              eq(chatParticipants.conversationId, convo.id),
              eq(chatParticipants.side, 'b'),
            ),
          );
      }

      return inserted;
    });

    const message = {
      id: row.id,
      conversationId: row.conversationId,
      senderId: row.senderId,
      senderRole: row.senderRole,
      senderSide: row.senderSide,
      type: row.type,
      text: row.text ?? undefined,
      status: row.status,
      sentAt: row.sentAt.toISOString(),
    };

    this.realtime.emitTo(
      ChatRealtimeService.room('buyer', convo.buyerId),
      'message.new',
      { conversationId: convo.id, message },
    );
    this.realtime.emitTo(
      ChatRealtimeService.room('shop', convo.shopId),
      'message.new',
      { conversationId: convo.id, message },
    );
    // Refreshes both sidebars: the preview line and, on the seller's side, the
    // unread badge this reply just took back down.
    await this.conversations.broadcastUpdated(convo.id);
  }
}
