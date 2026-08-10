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
import { and, eq, inArray } from 'drizzle-orm';
import { Inject } from '@nestjs/common';
import type { Server, Socket } from 'socket.io';
import { chatParticipants } from '../../database/schema';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import { chatConversations } from '../../database/schema';
import type { ChatActor } from './chat-actor';
import type { ChatParty } from './chat-parties';
import { isParty } from './participant-unread.util';
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
      for (const room of rooms) await client.join(room);
      const cameOnline = new Set(
        rooms.filter((room) => this.realtime.connected(room, client.id)),
      );

      // Anything sent while this side was away is now delivered.
      await this.messages.markDeliveredOnConnect(actor);

      for (const party of parties) {
        if (cameOnline.has(ChatRealtimeService.partyRoom(party))) {
          await this.broadcastPartyPresence(party, true);
        }
      }
    } catch {
      client.emit('error', { message: 'Unauthorized' });
      client.disconnect(true);
    }
  }

  async handleDisconnect(client: ChatSocket): Promise<void> {
    const actor = client.data.actor;
    if (!actor) return;
    const parties = await this.conversations.partySetFor(actor);
    for (const party of parties) {
      const room = ChatRealtimeService.partyRoom(party);
      if (this.realtime.disconnected(room, client.id)) {
        await this.broadcastPartyPresence(party, false);
      }
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
    const participants = await this.db.query.chatParticipants.findMany({
      where: eq(chatParticipants.conversationId, convo.id),
    });
    const mine = participants.find((side) =>
      parties.some((party) => isParty(side, party)),
    );
    if (!mine) return;
    const counterpart = participants.find((side) => side.side !== mine.side);
    if (!counterpart) return;
    this.realtime.emitTo(
      ChatRealtimeService.partyRoom({
        kind: counterpart.kind,
        id:
          counterpart.kind === 'account'
            ? counterpart.accountId
            : counterpart.kind === 'shop'
              ? counterpart.shopId
              : null,
      }),
      'typing',
      {
        conversationId: convo.id,
        isTyping: body.isTyping === true,
      },
    );
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

  /** Tell every counterpart of one party that it went on/offline. */
  private async broadcastPartyPresence(
    party: ChatParty,
    online: boolean,
  ): Promise<void> {
    // Support has no presence to broadcast - the desk is not "online" the way
    // a person or a shop is.
    if (party.kind === 'support') return;
    const mine = await this.db.query.chatParticipants.findMany({
      where:
        party.kind === 'account'
          ? and(
              eq(chatParticipants.kind, 'account'),
              eq(chatParticipants.accountId, party.id as string),
            )
          : and(
              eq(chatParticipants.kind, 'shop'),
              eq(chatParticipants.shopId, party.id as string),
            ),
    });
    if (!mine.length) return;
    const conversationIds = [...new Set(mine.map((p) => p.conversationId))];
    const participants = await this.db.query.chatParticipants.findMany({
      where: inArray(chatParticipants.conversationId, conversationIds),
    });
    const payload = {
      kind: party.kind,
      id: party.id as string,
      online,
      lastSeenAt: online ? undefined : this.realtime.partyLastSeenAt(party),
    };
    const counterpartRooms = new Set(
      participants
        .filter((p) => !isParty(p, party))
        .map((p) =>
          ChatRealtimeService.partyRoom({
            kind: p.kind,
            id:
              p.kind === 'account'
                ? p.accountId
                : p.kind === 'shop'
                  ? p.shopId
                  : null,
          }),
        ),
    );
    for (const room of counterpartRooms) {
      this.realtime.emitTo(room, 'presence', payload);
    }
  }
}
