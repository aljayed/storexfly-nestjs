import { Injectable } from '@nestjs/common';
import type { Server } from 'socket.io';
import type { ChatActor } from './chat-actor';
import type { ChatParty } from './chat-parties';

/**
 * Presence bookkeeping + WebSocket fan-out, shared by the gateway and the
 * REST services. The gateway hands its Socket.IO server in on init; services
 * emit through the helpers below without depending on the gateway itself
 * (avoids a circular dependency).
 *
 * Rooms: `buyer:{buyerId}` for the customer side, `shop:{shopId}` for the
 * seller side (every staff socket of a shop shares its room). Presence and
 * last-seen live in memory - a restart just degrades "Online" to
 * "Last seen recently", which the UI already handles.
 */
@Injectable()
export class ChatRealtimeService {
  private server: Server | null = null;
  private readonly sockets = new Map<string, Set<string>>();
  private readonly lastSeen = new Map<string, Date>();

  attachServer(server: Server): void {
    this.server = server;
  }

  /**
   * Room key for one side of a conversation.
   *
   * Keyed by party rather than by role: a shop owner is the shop in one thread
   * and themselves in the next, so a socket that joined only `shop:` would
   * never hear the messages addressed to the person.
   */
  static room(side: 'buyer' | 'shop', id: string): string {
    return `${side}:${id}`;
  }

  /** Room for a participant of a thread. */
  static partyRoom(party: ChatParty): string {
    return party.kind === 'shop'
      ? ChatRealtimeService.room('shop', party.id ?? '')
      : party.kind === 'account'
        ? ChatRealtimeService.room('buyer', party.id ?? '')
        : 'support';
  }

  /** Every room a viewer should be listening in. */
  static actorRooms(parties: ChatParty[]): string[] {
    return [...new Set(parties.map((p) => ChatRealtimeService.partyRoom(p)))];
  }

  static actorRoom(actor: ChatActor): string {
    return actor.role === 'customer'
      ? ChatRealtimeService.room('buyer', actor.id)
      : ChatRealtimeService.room('shop', actor.shopId);
  }

  /** Track a connected socket; returns true if this identity just came online. */
  connected(room: string, socketId: string): boolean {
    let set = this.sockets.get(room);
    if (!set) {
      set = new Set();
      this.sockets.set(room, set);
    }
    const cameOnline = set.size === 0;
    set.add(socketId);
    return cameOnline;
  }

  /** Untrack a socket; returns true if this identity just went offline. */
  disconnected(room: string, socketId: string): boolean {
    const set = this.sockets.get(room);
    if (!set) return false;
    set.delete(socketId);
    if (set.size === 0) {
      this.sockets.delete(room);
      this.lastSeen.set(room, new Date());
      return true;
    }
    return false;
  }

  isOnline(side: 'buyer' | 'shop', id: string): boolean {
    return this.sockets.has(ChatRealtimeService.room(side, id));
  }

  lastSeenAt(side: 'buyer' | 'shop', id: string): string | undefined {
    return this.lastSeen.get(ChatRealtimeService.room(side, id))?.toISOString();
  }

  /** Emit an event to one room. No-op until the gateway has attached. */
  emitTo(room: string, event: string, payload: unknown): void {
    this.server?.to(room).emit(event, payload);
  }
}
