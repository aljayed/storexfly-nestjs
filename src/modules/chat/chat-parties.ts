import type { ChatPartyKind } from '../../database/schema';
import type { ChatActor } from './chat-actor';

/** One side of a thread: what kind of party, and which one. */
export interface ChatParty {
  kind: ChatPartyKind;
  /** Account id, shop id, or null for support - which has exactly one desk. */
  id: string | null;
}

/**
 * The parties a viewer speaks as.
 *
 * A shop owner is two of them - themselves, and their storefront - which is
 * why their inbox is the same list in the console and on their storefront
 * profile: not two inboxes kept in step, but one query over both parties.
 *
 * Invited staff are only ever the shop. An owner's conversations with other
 * shops are their own business, and a console token must not open them.
 */
export function partiesOf(
  actor: ChatActor,
  extra: {
    /** The account behind a seller session, when it is the shop's owner. */
    ownerAccountId?: string | null;
    /** Shops this account owns - a seller reaches the same inbox from their
     *  storefront profile as from the console. */
    ownedShopIds?: string[];
  } = {},
): ChatParty[] {
  if (actor.role === 'customer') {
    return [
      { kind: 'account', id: actor.id },
      ...(extra.ownedShopIds ?? []).map(
        (id): ChatParty => ({ kind: 'shop', id }),
      ),
    ];
  }
  const parties: ChatParty[] = [{ kind: 'shop', id: actor.shopId }];
  if (extra.ownerAccountId) {
    parties.push({ kind: 'account', id: extra.ownerAccountId });
  }
  return parties;
}

/** Stable key for a party, matching the sorted `pair_key` on a conversation. */
export function partyKey(party: ChatParty): string {
  return `${party.kind}:${party.id ?? ''}`;
}

/**
 * Identity of a thread, independent of who opened it: both parties' keys,
 * sorted, so (A,B) and (B,A) are the same thread.
 */
export function pairKeyFor(a: ChatParty, b: ChatParty): string {
  return [partyKey(a), partyKey(b)].sort().join('|');
}

/** Which slot each party takes - side 'a' is the one that sorts first. */
export function sidesFor(
  a: ChatParty,
  b: ChatParty,
): { a: ChatParty; b: ChatParty } {
  return partyKey(a) <= partyKey(b) ? { a, b } : { a: b, b: a };
}
