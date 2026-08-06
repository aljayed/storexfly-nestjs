/**
 * What each CarryBee webhook event does to the order behind it.
 *
 * The courier is the only party in the fulfilment chain a shop cannot edit,
 * so this table - not the seller - is what moves an order past 'HandedOver'.
 * Anything not listed here is stored as a courier status badge and changes
 * nothing else.
 */
export type CourierEffect =
  /** Badge only: the parcel moved inside the network. */
  | 'none'
  /** The courier has the parcel and it is moving - order becomes 'Shipped'. */
  | 'shipped'
  /** Handed to the buyer - order becomes 'Delivered' and COD cash is in. */
  | 'delivered'
  /** A delivery attempt failed; the courier will try again. Reason recorded. */
  | 'attempt_failed'
  /** The parcel is back with the merchant - order is cancelled and restocked. */
  | 'returned'
  /** The courier remitted this consignment's invoice to the platform. */
  | 'remitted';

export interface CarrybeeEventRule {
  /** Stored on the order as `courierStatus`. */
  status: string;
  effect: CourierEffect;
}

/**
 * CarryBee event name → what we record and do.
 *
 * Every "the parcel is somewhere in the network" event maps to 'shipped'
 * rather than only `order.picked`: webhooks can be missed or arrive out of
 * order, and any of them is proof the courier holds the parcel, so a dropped
 * pickup event can't leave an order stuck.
 */
export const CARRYBEE_EVENTS: Readonly<Record<string, CarrybeeEventRule>> = {
  'order.created': { status: 'created', effect: 'none' },
  'order.create-failed': { status: 'create_failed', effect: 'none' },
  'order.updated': { status: 'updated', effect: 'none' },
  'order.pickup-requested': { status: 'pickup_requested', effect: 'none' },
  'order.assigned-for-pickup': {
    status: 'assigned_for_pickup',
    effect: 'none',
  },
  'order.pickup-failed': { status: 'pickup_failed', effect: 'none' },
  'order.pickup-cancelled': { status: 'pickup_cancelled', effect: 'none' },

  'order.picked': { status: 'picked', effect: 'shipped' },
  'order.at-the-sorting-hub': {
    status: 'at_the_sorting_hub',
    effect: 'shipped',
  },
  'order.on-the-way-to-central-warehouse': {
    status: 'on_the_way_to_central_warehouse',
    effect: 'shipped',
  },
  'order.at-central-warehouse': {
    status: 'at_central_warehouse',
    effect: 'shipped',
  },
  'order.in-transit': { status: 'in_transit', effect: 'shipped' },
  'order.received-at-last-mile-hub': {
    status: 'received_at_last_mile_hub',
    effect: 'shipped',
  },
  'order.assigned-for-delivery': {
    status: 'assigned_for_delivery',
    effect: 'shipped',
  },
  'order.delivery-on-hold': { status: 'delivery_on_hold', effect: 'none' },

  'order.delivered': { status: 'delivered', effect: 'delivered' },
  // A partial delivery still completes the order; `collected_amount` carries
  // what the buyer actually paid, which is less than the order total.
  'order.partial-delivery': {
    status: 'partial_delivery',
    effect: 'delivered',
  },
  'order.delivery-failed': {
    status: 'delivery_failed',
    effect: 'attempt_failed',
  },

  // The return leg. Only arrival back at the merchant is terminal - the
  // in-between states would cancel an order that is still in play.
  'order.returned': { status: 'returned', effect: 'none' },
  'order.returned-at-sorting': {
    status: 'returned_at_sorting',
    effect: 'none',
  },
  'order.returned-in-transit': {
    status: 'returned_in_transit',
    effect: 'none',
  },
  'order.paid-return': { status: 'paid_return', effect: 'none' },
  'order.returned-to-merchant': {
    status: 'returned_to_merchant',
    effect: 'returned',
  },

  'order.exchange': { status: 'exchange', effect: 'none' },
  'order.paid': { status: 'paid', effect: 'remitted' },
};

/**
 * Stored status → effect, derived from the table above so a polled status
 * refresh reaches the same conclusion as the webhook that would have carried
 * it. Refreshes read CarryBee's `transfer_status`, which uses the same
 * vocabulary as the event names.
 */
export const CARRYBEE_STATUS_EFFECTS: Readonly<Record<string, CourierEffect>> =
  Object.fromEntries(
    Object.values(CARRYBEE_EVENTS).map((rule) => [rule.status, rule.effect]),
  );

/**
 * The webhook body, as far as we care about it. CarryBee sends a different
 * subset per event, so everything past the identifiers is optional.
 */
export interface CarrybeeWebhookBody {
  event?: string;
  store_id?: string;
  consignment_id?: string;
  merchant_order_id?: string;
  timestamptz?: string;
  collected_amount?: number | string;
  collectable_amount?: number | string;
  cod_fee?: number | string;
  delivery_fee?: number | string;
  attempt?: number;
  reason?: string;
  remarks?: string;
  invoice_id?: string;
}
