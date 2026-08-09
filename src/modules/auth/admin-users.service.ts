import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import {
  adminUsers,
  type AdminUserRow,
  type NewAdminUserRow,
} from '../../database/schema';

/** Data-access for admin-console staff accounts (`admin_users`). */
@Injectable()
export class AdminUsersService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async findById(id: string): Promise<AdminUserRow | undefined> {
    return this.db.query.adminUsers.findFirst({
      where: eq(adminUsers.id, id),
    });
  }

  async findByEmail(email: string): Promise<AdminUserRow | undefined> {
    return this.db.query.adminUsers.findFirst({
      where: eq(adminUsers.email, email.toLowerCase()),
    });
  }

  async create(data: NewAdminUserRow): Promise<AdminUserRow> {
    const [row] = await this.db
      .insert(adminUsers)
      .values({ ...data, email: data.email.toLowerCase() })
      .returning();
    return row;
  }

  /** Replaces a staff member's console password. Owners never reach this -
   *  they authenticate against their Hoomri account row instead. */
  async updatePassword(id: string, passwordHash: string): Promise<void> {
    await this.db
      .update(adminUsers)
      .set({ passwordHash })
      .where(eq(adminUsers.id, id));
  }

  async markLogin(id: string): Promise<void> {
    await this.db
      .update(adminUsers)
      .set({ lastLoginAt: new Date() })
      .where(eq(adminUsers.id, id));
  }
}
