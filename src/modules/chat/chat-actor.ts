import type { Request } from 'express';

/**
 * The authenticated chat participant, resolved by ChatTokenService. This is
 * the chat module's own principal type - deliberately decoupled from the
 * platform's `Principal` union so the module ports to another host by
 * re-implementing only the token adapter.
 */
export interface CustomerActor {
  role: 'customer';
  /** Buyer id in this host platform. */
  id: string;
  name: string;
  email: string;
}

export interface SellerActor {
  role: 'seller';
  /** Admin-user id - the staff member replying on the shop's behalf. */
  id: string;
  /** The shop this seller session is scoped to. */
  shopId: string;
  name: string;
}

/**
 * Hoomri Support - the platform's own desk.
 *
 * One desk rather than one row per operator: a seller writes to "Hoomri
 * Support", not to whoever happens to be on shift, and the thread outlives any
 * individual's account. `id` is the platform operator answering, kept for the
 * audit trail on each message.
 */
export interface SupportActor {
  role: 'support';
  /** The platform operator behind this session. */
  id: string;
  name: string;
  email: string;
}

export type ChatActor = CustomerActor | SellerActor | SupportActor;

export interface RequestWithChatActor extends Request {
  chatActor: ChatActor;
}
