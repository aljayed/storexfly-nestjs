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

export type ChatActor = CustomerActor | SellerActor;

export interface RequestWithChatActor extends Request {
  chatActor: ChatActor;
}
