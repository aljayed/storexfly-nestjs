import type { DrizzleDB } from '../../database/drizzle.types';
import { chatParticipants } from '../../database/schema';
import { sidesFor, type ChatParty } from './chat-parties';

/**
 * Record both sides of a thread.
 *
 * Written once at creation - the pair is what a conversation *is*, so it never
 * changes afterwards, and re-running this is a no-op. Lives here rather than
 * on a service because threads are opened from three places (a buyer starting
 * one, a shop messaging a customer, an offer being sent) and all three have to
 * agree on what a participant row looks like.
 */
export async function writeThreadParticipants(
  db: DrizzleDB,
  conversationId: string,
  first: ChatParty,
  second: ChatParty,
): Promise<void> {
  const sides = sidesFor(first, second);
  await db
    .insert(chatParticipants)
    .values(
      (['a', 'b'] as const).map((side) => {
        const party = sides[side];
        return {
          conversationId,
          side,
          kind: party.kind,
          accountId: party.kind === 'account' ? party.id : null,
          shopId: party.kind === 'shop' ? party.id : null,
        };
      }),
    )
    .onConflictDoNothing();
}

/** The buyer↔shop pair, which is what every thread is until support lands. */
export function buyerShopParties(
  buyerAccountId: string,
  shopId: string,
): [ChatParty, ChatParty] {
  return [
    { kind: 'account', id: buyerAccountId },
    { kind: 'shop', id: shopId },
  ];
}
