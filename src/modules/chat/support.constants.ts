/**
 * How Hoomri Support appears to whoever it is writing to.
 *
 * A seller sees the platform's desk, not the name of the operator on shift -
 * the thread belongs to Hoomri and outlives any individual's account. The
 * address is the one a reply would reach.
 */
export const SUPPORT_NAME = 'Hoomri Support';
export const SUPPORT_EMAIL = 'contact@hoomri.com';

/** Party id for the desk. There is exactly one, so it needs no row. */
export const SUPPORT_PARTY_ID = 'support';

/**
 * Author id on a message from the desk.
 *
 * The platform session carries no per-operator id - its subject is the literal
 * 'platform-admin' - so there is nothing finer to record, and `sender_id` is a
 * uuid column. A fixed id says "Hoomri Support wrote this", which is exactly
 * what the recipient is told.
 */
export const SUPPORT_SENDER_ID = '00000000-0000-0000-0000-000000000000';
