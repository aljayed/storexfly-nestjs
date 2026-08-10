import { and, eq, ne, sql } from 'drizzle-orm';
import type { DrizzleDB } from '../../database/drizzle.types';
import { chatParticipants, type ChatParticipantRow } from '../../database/schema';
import type { ChatParty } from './chat-parties';

type Db = DrizzleDB | Parameters<Parameters<DrizzleDB['transaction']>[0]>[0];

/** Is this participant row the given party? */
export function isParty(row: ChatParticipantRow, party: ChatParty): boolean {
  return party.kind === 'account'
    ? row.kind === 'account' && row.accountId === party.id
    : party.kind === 'shop'
      ? row.kind === 'shop' && row.shopId === party.id
      : row.kind === 'support';
}

/**
 * Which side of a thread a viewer is on, or null when they are on neither.
 *
 * Unread lives on the participant rather than the conversation because "unread
 * for whom" is a property of a side: a shop owner reading their own inbox is
 * the buyer in one thread and the shop in the next, and a single pair of
 * counters on the conversation cannot say which of those a number belongs to.
 */
export async function sideOf(
  db: Db,
  conversationId: string,
  parties: ChatParty[],
): Promise<ChatParticipantRow | null> {
  const rows = await db
    .select()
    .from(chatParticipants)
    .where(eq(chatParticipants.conversationId, conversationId));
  return rows.find((row) => parties.some((p) => isParty(row, p))) ?? null;
}

/** Count a new message against everyone except the side that sent it. */
export async function bumpUnreadForOthers(
  db: Db,
  conversationId: string,
  senderSide: string,
): Promise<void> {
  await db
    .update(chatParticipants)
    .set({ unread: sql`${chatParticipants.unread} + 1` })
    .where(
      and(
        eq(chatParticipants.conversationId, conversationId),
        ne(chatParticipants.side, senderSide),
      ),
    );
}

/** This side has caught up. */
export async function clearUnreadFor(
  db: Db,
  conversationId: string,
  side: string,
): Promise<void> {
  await db
    .update(chatParticipants)
    .set({ unread: 0, lastReadAt: new Date() })
    .where(
      and(
        eq(chatParticipants.conversationId, conversationId),
        eq(chatParticipants.side, side),
      ),
    );
}
