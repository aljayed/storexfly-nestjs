import { Logger } from '@nestjs/common';
import {
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { eq } from 'drizzle-orm';
import { Inject } from '@nestjs/common';
import type { Server, Socket } from 'socket.io';
import { chatParticipants } from '../../database/schema';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import { chatConversations } from '../../database/schema';
import type { ChatActor } from './chat-actor';
import { ChatRealtimeService } from './chat-realtime.service';
import { ConversationsService } from './conversations.service';
import { ChatTokenService } from './chat-token.service';
import { MessagesService } from './messages.service';

interface ChatSocket extends Socket {
  data: {
    actor?: ChatActor;
    /** Every party room this socket joined, so disconnect can leave them. */
    rooms?: string[];
    eventWindow?: { start: number; count: number };
  };
}

// Per-socket inbound event budget. Every typing/read event costs a DB lookup,
// so cap the rate; the REST throttler doesn't cover the gateway.
const EVENT_WINDOW_MS = 10_000;
const EVENTS_PER_WINDOW = 30;

/** True when this socket may spend another event; silently drops the excess. */
function withinBudget(client: ChatSocket): boolean {
  const now = Date.now();
  const win = client.data.eventWindow;
  if (!win || now - win.start > EVENT_WINDOW_MS) {
    client.data.eventWindow = { start: now, count: 1 };
    return true;
  }
  win.count += 1;
  return win.count <= EVENTS_PER_WINDOW;
}

const corsOrigins = (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

/**
 * Real-time side of the chat: presence, typing, live delivery and read
 * receipts. Serves under its own Socket.IO path (`/api/chat-ws`) so the Vue
 * dev proxy and any reverse proxy can route it independently of the host
 * app's REST traffic. Auth: the same platform token the REST guard accepts,
 * passed in the connection's `auth.token`.
 */
@WebSocketGateway({
  namespace: '/chat',
  path: '/api/chat-ws',
  cors: { origin: corsOrigins, credentials: true },
})
export class ChatGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(ChatGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly tokens: ChatTokenService,
    private readonly realtime: ChatRealtimeService,
    private readonly messages: MessagesService,
    private readonly conversations: ConversationsService,
  ) {}

  afterInit(server: Server): void {
    this.realtime.attachServer(server);
  }

  async handleConnection(client: ChatSocket): Promise<void> {
    try {
      const token = (client.handshake.auth as { token?: string })?.token;
      const actor = await this.tokens.verify(token);
      client.data.actor = actor;

      // Join a room per party this viewer speaks as - an owner listens as
      // their shop *and* as themselves, from one socket.
      const parties = await this.conversations.partySetFor(actor);
      const rooms = ChatRealtimeService.actorRooms(parties);
      client.data.rooms = rooms;
      await Promise.all(rooms.map((r) => client.join(r)));
      // Presence is still tracked on the identity's own room.
      const room = ChatRealtimeService.actorRoom(actor);
      const cameOnline = this.realtime.connected(room, client.id);

      // Anything sent while this side was away is now delivered.
      await this.messages.markDeliveredOnConnect(actor);

      if (cameOnline) {
        await this.broadcastPresence(actor, true);
      }
    } catch {
      client.emit('error', { message: 'Unauthorized' });
      client.disconnect(true);
    }
  }

  async handleDisconnect(client: ChatSocket): Promise<void> {
    const actor = client.data.actor;
    if (!actor) return;
    const room = ChatRealtimeService.actorRoom(actor);
    const wentOffline = this.realtime.disconnected(room, client.id);
    if (wentOffline) {
      await this.broadcastPresence(actor, false);
    }
  }

  @SubscribeMessage('typing')
  async onTyping(
    @ConnectedSocket() client: ChatSocket,
    @MessageBody() body: { conversationId?: string; isTyping?: boolean },
  ): Promise<void> {
    const actor = client.data.actor;
    if (!actor || !body?.conversationId || !withinBudget(client)) return;
    if (typeof body.conversationId !== 'string') return;
    const convo = await this.db.query.chatConversations.findFirst({
      where: eq(chatConversations.id, body.conversationId),
    });
    if (!convo) return;
    // Typing is a per-thread signal, so membership is the same question the
    // inbox asks: is this viewer one of the two parties?
    const parties = await this.conversations.partySetFor(actor);
    const mine = await this.db.query.chatParticipants.findMany({
      where: eq(chatParticipants.conversationId, convo.id),
      columns: { kind: true, accountId: true, shopId: true },
    });
    const isMember = mine.length
      ? mine.some((side) =>
          parties.some((p) =>
            p.kind === 'account'
              ? side.kind === 'account' && side.accountId === p.id
              : p.kind === 'shop'
                ? side.kind === 'shop' && side.shopId === p.id
                : side.kind === 'support',
          ),
        )
      : actor.role === 'customer'
        ? convo.buyerId === actor.id
        : actor.role === 'seller' && convo.shopId === actor.shopId;
    if (!isMember) return;
    // Threads without a shop or buyer side get their typing indicator once
    // the party rooms land there too; nothing to notify until then.
    const counterpartRoom =
      actor.role === 'customer'
        ? convo.shopId && ChatRealtimeService.room('shop', convo.shopId)
        : convo.buyerId && ChatRealtimeService.room('buyer', convo.buyerId);
    if (!counterpartRoom) return;
    this.realtime.emitTo(counterpartRoom, 'typing', {
      conversationId: convo.id,
      isTyping: body.isTyping === true,
    });
  }

  @SubscribeMessage('read')
  async onRead(
    @ConnectedSocket() client: ChatSocket,
    @MessageBody() body: { conversationId?: string; upToMessageId?: string },
  ): Promise<void> {
    const actor = client.data.actor;
    if (!actor || !body?.conversationId || !body?.upToMessageId) return;
    if (
      typeof body.conversationId !== 'string' ||
      typeof body.upToMessageId !== 'string' ||
      !withinBudget(client)
    ) {
      return;
    }
    try {
      await this.messages.markRead(actor, body.conversationId, {
        upToMessageId: body.upToMessageId,
      });
    } catch (err) {
      this.logger.debug(`read event rejected: ${String(err)}`);
    }
  }

  /** Tell every counterpart of this actor that they went on/offline. */
  private async broadcastPresence(
    actor: ChatActor,
    online: boolean,
  ): Promise<void> {
    const isCustomer = actor.role === 'customer';
    // Support has no presence to broadcast - the desk is not "online" the way
    // a person or a shop is.
    if (actor.role === 'support') return;
    const convos = await this.db.query.chatConversations.findMany({
      where: isCustomer
        ? eq(chatConversations.buyerId, actor.id)
        : eq(chatConversations.shopId, actor.shopId),
      columns: { buyerId: true, shopId: true },
    });
    const payload = {
      role: actor.role,
      // Sellers present as their shop (any staff socket online = shop online).
      id: isCustomer ? actor.id : actor.shopId,
      online,
      lastSeenAt: online
        ? undefined
        : this.realtime.lastSeenAt(
            isCustomer ? 'buyer' : 'shop',
            isCustomer ? actor.id : actor.shopId,
          ),
    };
    const counterpartRooms = new Set(
      convos
        .map((c) =>
          isCustomer
            ? c.shopId && ChatRealtimeService.room('shop', c.shopId)
            : c.buyerId && ChatRealtimeService.room('buyer', c.buyerId),
        )
        .filter((room): room is string => !!room),
    );
    for (const room of counterpartRooms) {
      this.realtime.emitTo(room, 'presence', payload);
    }
  }
}
