/**
 * Username rules, in one place because the claim endpoint, the availability
 * check and any future importer all have to agree on them.
 */

/** 3-24 chars, starts with a letter, letters/digits/._ inside, ends alphanumeric. */
const HANDLE_RE = /^[a-z][a-z0-9._]{1,22}[a-z0-9]$/;

/**
 * Names that must never belong to a person: platform identities someone could
 * impersonate, and the words support staff would be assumed to be.
 */
const RESERVED = new Set([
  'hoomri',
  'hoomrisupport',
  'hoomri_support',
  'support',
  'help',
  'helpdesk',
  'admin',
  'administrator',
  'moderator',
  'mod',
  'staff',
  'team',
  'official',
  'system',
  'root',
  'security',
  'billing',
  'payments',
  'refund',
  'refunds',
  'contact',
  'info',
  'noreply',
  'no_reply',
  'api',
  'www',
  'app',
  'me',
  'you',
  'null',
  'undefined',
  'settings',
  'account',
  'accounts',
  'login',
  'signin',
  'signup',
  'register',
  'verify',
  'shop',
  'shops',
  'store',
  'stores',
  'order',
  'orders',
  'chat',
  'inbox',
]);

export type HandleRejection =
  | 'too_short'
  | 'too_long'
  | 'format'
  | 'reserved'
  | 'taken'
  | 'email_unverified';

/** Lowercase and trim, and strip a leading "@" so "@rafiq" pastes cleanly. */
export function normalizeHandle(raw: string): string {
  return raw.trim().toLowerCase().replace(/^@+/, '');
}

/**
 * Shape check only - uniqueness needs the database. Returns null when the
 * handle is well-formed, otherwise why it is not.
 */
export function checkHandleShape(handle: string): HandleRejection | null {
  if (handle.length < 3) return 'too_short';
  if (handle.length > 24) return 'too_long';
  // No run of dots/underscores: "a..b" and "a__b" read as typos and make
  // near-identical names easy to pass off as each other.
  if (!HANDLE_RE.test(handle) || /[._]{2}/.test(handle)) return 'format';
  if (RESERVED.has(handle.replace(/[._]/g, ''))) return 'reserved';
  return null;
}
