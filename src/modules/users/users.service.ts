import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { generatePublicId } from '../../common/utils/public-id.util';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import { users, type NewUserRow, type UserRow } from '../../database/schema';

/**
 * Reduce any BD phone format to the bare 10-digit national number. The same
 * number arrives as "+8801712…", "01712…" or "1712…" depending on which door
 * it came through, and `users.phone` holds one of them - so every read and
 * write here goes through this first.
 */
function normalizePhone(raw: string | null | undefined): string {
  return (raw ?? '')
    .replace(/\D/g, '')
    .replace(/^880/, '')
    .replace(/^0+/, '');
}

export interface GoogleProfileInput {
  googleId: string;
  email: string;
  name: string;
}

/**
 * Data-access for platform accounts. Owns every read/write to the `users`
 * table so auth, shops, etc. share one consistent surface.
 */
@Injectable()
export class UsersService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async findById(id: string): Promise<UserRow | undefined> {
    return this.db.query.users.findFirst({ where: eq(users.id, id) });
  }

  async findByEmail(email: string): Promise<UserRow | undefined> {
    return this.db.query.users.findFirst({
      where: eq(users.email, email.toLowerCase()),
    });
  }

  async findByGoogleId(googleId: string): Promise<UserRow | undefined> {
    return this.db.query.users.findFirst({
      where: eq(users.googleId, googleId),
    });
  }

  async findByPhone(phone: string): Promise<UserRow | undefined> {
    return this.db.query.users.findFirst({ where: phoneMatches(phone) });
  }

  /**
   * The account that has already proven this number, if any. Used to keep one
   * verified phone tied to one account - otherwise a single number could
   * unlock free shops on an unlimited number of throwaway signups.
   */
  async findByVerifiedPhone(phone: string): Promise<UserRow | undefined> {
    return this.db.query.users.findFirst({
      where: and(phoneMatches(phone), eq(users.phoneVerified, true)),
    });
  }

  /**
   * Records a phone number the account just proved by SMS OTP, normalized so
   * one number is one string however it was typed. `phoneChanges` is the
   * updated rationing log, passed only when this write actually moves the
   * account off a number it had already proved.
   */
  async setVerifiedPhone(
    id: string,
    phone: string,
    phoneChanges?: string[],
  ): Promise<UserRow> {
    const [row] = await this.db
      .update(users)
      .set({
        phone: normalizePhone(phone),
        phoneVerified: true,
        ...(phoneChanges ? { phoneChanges } : {}),
      })
      .where(eq(users.id, id))
      .returning();
    return row;
  }

  /** Records an email address the account just proved by emailed OTP. */
  async setVerifiedEmail(id: string, email: string): Promise<UserRow> {
    const [row] = await this.db
      .update(users)
      .set({ email: email.toLowerCase(), emailVerified: true })
      .where(eq(users.id, id))
      .returning();
    return row;
  }

  /** Replaces the stored password hash (used by the reset-password flow). */
  async updatePassword(id: string, passwordHash: string): Promise<void> {
    await this.db.update(users).set({ passwordHash }).where(eq(users.id, id));
  }

  async create(data: Omit<NewUserRow, 'publicId'>): Promise<UserRow> {
    const normalized: NewUserRow = {
      ...data,
      // Stamped here rather than by callers: this is the funnel every
      // non-checkout account comes through, and an id assigned in one place
      // cannot be assigned inconsistently in three.
      publicId: generatePublicId(),
      email: data.email ? data.email.toLowerCase() : data.email,
    };
    const [row] = await this.db.insert(users).values(normalized).returning();
    return row;
  }

  /**
   * Find-or-create for the Google sign-in flow. Links a Google id to an
   * existing email account when one already exists.
   */
  async upsertGoogleUser(profile: GoogleProfileInput): Promise<UserRow> {
    const existingByGoogle = await this.findByGoogleId(profile.googleId);
    if (existingByGoogle) {
      return existingByGoogle;
    }

    const existingByEmail = await this.findByEmail(profile.email);
    if (existingByEmail) {
      const [row] = await this.db
        .update(users)
        .set({ googleId: profile.googleId, via: 'google', emailVerified: true })
        .where(eq(users.id, existingByEmail.id))
        .returning();
      return row;
    }

    return this.create({
      name: profile.name,
      email: profile.email,
      googleId: profile.googleId,
      via: 'google',
      emailVerified: true,
    });
  }
}

/**
 * Match a number against `users.phone` in either shape it may be stored in.
 * Rows written before the format was settled hold "+8801712…"; everything
 * since holds the bare national digits. Migration 0084 normalizes the old
 * ones, and matching both keeps a number that slipped through from looking
 * unclaimed - which is what would let a second account verify it.
 */
function phoneMatches(phone: string) {
  const national = normalizePhone(phone);
  if (!national) return eq(users.phone, phone);
  return inArray(users.phone, [national, `+880${national}`, `0${national}`]);
}
