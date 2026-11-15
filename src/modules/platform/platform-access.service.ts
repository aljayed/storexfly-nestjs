import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { randomInt } from 'crypto';
import { asc, count, eq, sql } from 'drizzle-orm';
import {
  hasGrant,
  OWNER_ROLE,
  PLATFORM_WORKSPACES,
  sanitizeGrants,
  type PlatformGrants,
} from '../../common/auth/platform-access';
import type { PlatformPrincipal } from '../../common/types/principal';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import { platformRoles, platformStaff } from '../../database/schema';
import { isUniqueViolation } from '../../common/utils/postgres-error.util';
import { BCRYPT_ROUNDS } from './platform-auth.service';
import type {
  CreatePlatformRoleDto,
  CreatePlatformStaffDto,
  UpdatePlatformRoleDto,
  UpdatePlatformStaffDto,
} from './dto/platform-access.dto';

// No 0/O, 1/l/I - the password is read off a screen and typed once.
const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function tempPassword(): string {
  let out = '';
  for (let i = 0; i < 14; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/**
 * Team and access: staff accounts and the roles they hold. Two rules keep it
 * safe as the team grows:
 *  - nobody can hand out access they do not hold themselves (the owner can);
 *  - the owner's account and role are untouchable from the console - the owner
 *    is whoever holds the server's PLATFORM_ADMIN_* credentials.
 */
@Injectable()
export class PlatformAccessService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async staff() {
    return this.db
      .select({
        id: platformStaff.id,
        name: platformStaff.name,
        email: platformStaff.email,
        roleKey: platformStaff.roleKey,
        roleName: platformRoles.name,
        status: platformStaff.status,
        twoFactorEnabled: platformStaff.twoFactorEnabled,
        mustChangePassword: platformStaff.mustChangePassword,
        lastLoginAt: platformStaff.lastLoginAt,
        createdAt: platformStaff.createdAt,
      })
      .from(platformStaff)
      .innerJoin(platformRoles, eq(platformRoles.key, platformStaff.roleKey))
      .orderBy(asc(platformStaff.name));
  }

  async createStaff(actor: PlatformPrincipal, dto: CreatePlatformStaffDto) {
    await this.assertAssignable(actor, dto.roleKey);
    const password = tempPassword();
    try {
      const [row] = await this.db
        .insert(platformStaff)
        .values({
          name: dto.name.trim(),
          email: dto.email.trim().toLowerCase(),
          roleKey: dto.roleKey,
          passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
          mustChangePassword: true,
          createdBy: actor.id,
        })
        .returning({ id: platformStaff.id, email: platformStaff.email });
      return { id: row.id, email: row.email, temporaryPassword: password };
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          'Someone on the team already uses that email',
        );
      }
      throw err;
    }
  }

  async updateStaff(
    actor: PlatformPrincipal,
    id: string,
    dto: UpdatePlatformStaffDto,
  ) {
    const target = await this.editableStaff(actor, id);
    const patch: Partial<typeof platformStaff.$inferInsert> = {};
    let endSessions = false;
    if (dto.name !== undefined) patch.name = dto.name.trim();
    if (dto.roleKey !== undefined && dto.roleKey !== target.roleKey) {
      await this.assertAssignable(actor, dto.roleKey);
      patch.roleKey = dto.roleKey;
      endSessions = true;
    }
    if (dto.status !== undefined && dto.status !== target.status) {
      patch.status = dto.status;
      endSessions = true;
    }
    if (!Object.keys(patch).length) return { ok: true };
    await this.db
      .update(platformStaff)
      .set({
        ...patch,
        ...(endSessions
          ? { sessionVersion: sql`${platformStaff.sessionVersion} + 1` }
          : {}),
      })
      .where(eq(platformStaff.id, id));
    return { ok: true };
  }

  async resetPassword(actor: PlatformPrincipal, id: string) {
    await this.editableStaff(actor, id);
    const password = tempPassword();
    await this.db
      .update(platformStaff)
      .set({
        passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
        mustChangePassword: true,
        sessionVersion: sql`${platformStaff.sessionVersion} + 1`,
      })
      .where(eq(platformStaff.id, id));
    return { temporaryPassword: password };
  }

  async resetTwoFactor(actor: PlatformPrincipal, id: string) {
    await this.editableStaff(actor, id, {
      allowOwnerTarget: actor.roleKey === OWNER_ROLE,
    });
    await this.db
      .update(platformStaff)
      .set({
        twoFactorEnabled: false,
        twoFactorSecret: null,
        sessionVersion: sql`${platformStaff.sessionVersion} + 1`,
      })
      .where(eq(platformStaff.id, id));
    return { ok: true };
  }

  async signOut(actor: PlatformPrincipal, id: string) {
    await this.editableStaff(actor, id, { allowSelf: true });
    await this.db
      .update(platformStaff)
      .set({ sessionVersion: sql`${platformStaff.sessionVersion} + 1` })
      .where(eq(platformStaff.id, id));
    return { ok: true };
  }

  async roles() {
    const members = this.db
      .select({ roleKey: platformStaff.roleKey, n: count().as('n') })
      .from(platformStaff)
      .groupBy(platformStaff.roleKey)
      .as('members');
    const rows = await this.db
      .select({
        key: platformRoles.key,
        name: platformRoles.name,
        description: platformRoles.description,
        grants: platformRoles.grants,
        system: platformRoles.system,
        members: sql<number>`coalesce(${members.n}, 0)`.mapWith(Number),
      })
      .from(platformRoles)
      .leftJoin(members, eq(members.roleKey, platformRoles.key))
      .orderBy(
        sql`${platformRoles.key} = ${OWNER_ROLE} desc`,
        asc(platformRoles.name),
      );
    return { workspaces: PLATFORM_WORKSPACES, roles: rows };
  }

  async createRole(actor: PlatformPrincipal, dto: CreatePlatformRoleDto) {
    const grants = sanitizeGrants(dto.grants);
    this.assertWithin(actor, grants);
    const key =
      dto.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 32) || 'role';
    try {
      const [row] = await this.db
        .insert(platformRoles)
        .values({
          key: `${key}_${randomInt(1000, 9999)}`,
          name: dto.name.trim(),
          description: dto.description?.trim() || null,
          grants,
          system: false,
        })
        .returning();
      return row;
    } catch (err) {
      if (isUniqueViolation(err))
        throw new ConflictException('Try another name');
      throw err;
    }
  }

  async updateRole(
    actor: PlatformPrincipal,
    key: string,
    dto: UpdatePlatformRoleDto,
  ) {
    if (key === OWNER_ROLE) {
      throw new ForbiddenException('The owner role always has full access');
    }
    const [role] = await this.db
      .select()
      .from(platformRoles)
      .where(eq(platformRoles.key, key))
      .limit(1);
    if (!role) throw new NotFoundException('Role not found');
    const patch: Partial<typeof platformRoles.$inferInsert> = {};
    if (dto.name !== undefined) patch.name = dto.name.trim();
    if (dto.description !== undefined)
      patch.description = dto.description?.trim() || null;
    if (dto.grants !== undefined) {
      const grants = sanitizeGrants(dto.grants);
      this.assertWithin(actor, grants);
      this.assertWithin(actor, role.grants);
      patch.grants = grants;
    }
    if (!Object.keys(patch).length) return role;
    const [row] = await this.db
      .update(platformRoles)
      .set(patch)
      .where(eq(platformRoles.key, key))
      .returning();
    return row;
  }

  async deleteRole(key: string) {
    const [role] = await this.db
      .select()
      .from(platformRoles)
      .where(eq(platformRoles.key, key))
      .limit(1);
    if (!role) throw new NotFoundException('Role not found');
    if (role.system) {
      throw new BadRequestException(
        'Starting roles can be edited but not deleted',
      );
    }
    const [{ n }] = await this.db
      .select({ n: count() })
      .from(platformStaff)
      .where(eq(platformStaff.roleKey, key));
    if (n > 0) {
      throw new BadRequestException(
        `${n} ${n === 1 ? 'person has' : 'people have'} this role. Move them to another role first.`,
      );
    }
    await this.db.delete(platformRoles).where(eq(platformRoles.key, key));
    return { ok: true };
  }

  /** The staff row an actor may change: never the owner, never themselves. */
  private async editableStaff(
    actor: PlatformPrincipal,
    id: string,
    opts: { allowSelf?: boolean; allowOwnerTarget?: boolean } = {},
  ) {
    const [row] = await this.db
      .select({
        id: platformStaff.id,
        roleKey: platformStaff.roleKey,
        status: platformStaff.status,
        grants: platformRoles.grants,
      })
      .from(platformStaff)
      .innerJoin(platformRoles, eq(platformRoles.key, platformStaff.roleKey))
      .where(eq(platformStaff.id, id))
      .limit(1);
    if (!row) throw new NotFoundException('Staff member not found');
    if (row.id === actor.id && !opts.allowSelf) {
      throw new ForbiddenException(
        'Ask someone else to change your own access',
      );
    }
    if (
      row.roleKey === OWNER_ROLE &&
      !opts.allowOwnerTarget &&
      row.id !== actor.id
    ) {
      throw new ForbiddenException("The owner's account can't be changed here");
    }
    if (row.roleKey !== OWNER_ROLE) this.assertWithin(actor, row.grants);
    return row;
  }

  private async assertAssignable(actor: PlatformPrincipal, roleKey: string) {
    if (roleKey === OWNER_ROLE) {
      throw new ForbiddenException(
        'There is one owner: whoever holds the server owner credentials',
      );
    }
    const [role] = await this.db
      .select()
      .from(platformRoles)
      .where(eq(platformRoles.key, roleKey))
      .limit(1);
    if (!role) throw new BadRequestException('Pick a role');
    this.assertWithin(actor, role.grants);
  }

  /** Refuses access the actor does not hold themselves. */
  private assertWithin(actor: PlatformPrincipal, grants: PlatformGrants) {
    if (actor.roleKey === OWNER_ROLE) return;
    for (const w of PLATFORM_WORKSPACES) {
      const level = grants[w];
      if (level && !hasGrant(actor.grants, w, level)) {
        throw new ForbiddenException(
          `You can't hand out ${level} access to ${w}: your own role doesn't have it`,
        );
      }
    }
  }
}
