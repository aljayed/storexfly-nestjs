import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import { users, type NewUserRow, type UserRow } from '../../database/schema';

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
    return this.db.query.users.findFirst({ where: eq(users.phone, phone) });
  }

  /**
   * The account that has already proven this number, if any. Used to keep one
   * verified phone tied to one account - otherwise a single number could
   * unlock free shops on an unlimited number of throwaway signups.
   */
  async findByVerifiedPhone(phone: string): Promise<UserRow | undefined> {
    return this.db.query.users.findFirst({
      where: and(eq(users.phone, phone), eq(users.phoneVerified, true)),
    });
  }

  /** Records a phone number the account just proved by SMS OTP. */
  async setVerifiedPhone(id: string, phone: string): Promise<UserRow> {
    const [row] = await this.db
      .update(users)
      .set({ phone, phoneVerified: true })
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

  async create(data: NewUserRow): Promise<UserRow> {
    const normalized: NewUserRow = {
      ...data,
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
