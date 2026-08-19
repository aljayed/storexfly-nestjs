import { randomBytes } from 'node:crypto';

/**
 * The permanent public id an account is known by - "HM7K3PQR".
 *
 * Everything else a person is identified by is theirs to change: email,
 * phone, username. This does not, and nothing is keyed on it changing, which
 * is what makes it safe for support to quote and for someone to recognise
 * their own account by after changing all three.
 *
 * Deliberately not the UUID: an account id gets read down a phone line and
 * typed back, so it leaves out the characters people confuse - O against 0,
 * I and L against 1 - and stays short enough to say out loud.
 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const LENGTH = 8;
const PREFIX = 'HM';

/**
 * One candidate id. Uniqueness is the database's - the column carries a
 * unique index, and it also carries its own DEFAULT so that an insert which
 * never goes through the ORM still gets one.
 *
 * 31^8 is about 850 billion: at a million accounts, the chance a new one
 * collides is roughly one in a million.
 */
export function generatePublicId(): string {
  const bytes = randomBytes(LENGTH);
  let out = PREFIX;
  for (let i = 0; i < LENGTH; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/** Accept the id however it was typed back - any case, spacing, or no prefix. */
export function normalizePublicId(raw: string): string {
  const cleaned = raw.trim().toUpperCase().replace(/[\s-]/g, '');
  return cleaned.startsWith(PREFIX) ? cleaned : `${PREFIX}${cleaned}`;
}
