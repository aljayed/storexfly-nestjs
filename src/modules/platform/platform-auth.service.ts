import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { createHash, timingSafeEqual } from 'crypto';
import { eq, sql } from 'drizzle-orm';
import type { Request } from 'express';
import { authenticator } from 'otplib';
import * as QRCode from 'qrcode';
import {
  OWNER_GRANTS,
  OWNER_ROLE,
  type PlatformGrants,
} from '../../common/auth/platform-access';
import type { PlatformPrincipal } from '../../common/types/principal';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import {
  platformRoles,
  platformStaff,
  type PlatformStaffRow,
} from '../../database/schema';
import { TokenService } from '../auth/token.service';
import { PlatformAuditService } from '../platform-audit/platform-audit.service';
import type {
  PlatformChangePasswordDto,
  PlatformCodeDto,
  PlatformLoginDto,
  PlatformNewPasswordDto,
} from './dto/platform-login.dto';

export const BCRYPT_ROUNDS = 12;
// Compared against when the email is unknown, so a miss costs the same time.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

export interface PlatformStaffProfile {
  id: string;
  name: string;
  email: string;
  role: { key: string; name: string };
  grants: PlatformGrants;
  isOwner: boolean;
}

export type PlatformSignInStep =
  | { stage: '2fa'; ticket: string }
  | {
      stage: 'enroll';
      ticket: string;
      secret: string;
      otpauthUrl: string;
      qrDataUrl: string;
    }
  | { stage: 'password'; ticket: string }
  | { stage: 'done'; token: string; admin: PlatformStaffProfile };

/**
 * Sign-in for the platform console. Every staff member has their own
 * account and must use an authenticator app; there is no shared login.
 *
 *   password -> (first time: set up the app) -> 6-digit code
 *            -> (assigned password: choose your own) -> session
 *
 * The platform owner signs in with the PLATFORM_ADMIN_EMAIL /
 * PLATFORM_ADMIN_PASSWORD credentials from the environment; their staff row
 * is created on the first such sign-in, so the console still works on an
 * empty database and the owner's password can never be lost or reset by
 * someone else.
 */
@Injectable()
export class PlatformAuthService {
  constructor(
    private readonly config: ConfigService,
    private readonly tokens: TokenService,
    private readonly audit: PlatformAuditService,
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
  ) {}

  async login(
    dto: PlatformLoginDto,
    req: Request,
  ): Promise<PlatformSignInStep> {
    const email = dto.email.trim().toLowerCase();
    const ownerEmail = this.config.getOrThrow<string>('platformAdmin.email');
    let staff: PlatformStaffRow | undefined;

    if (email === ownerEmail) {
      const ok = this.safeEqual(
        dto.password,
        this.config.getOrThrow<string>('platformAdmin.password'),
      );
      if (ok) staff = await this.ensureOwner(email);
    } else {
      const [row] = await this.db
        .select()
        .from(platformStaff)
        .where(eq(platformStaff.email, email))
        .limit(1);
      const ok = await bcrypt.compare(
        dto.password,
        row?.passwordHash ?? DUMMY_HASH,
      );
      if (ok && row?.passwordHash) staff = row;
    }

    if (!staff) {
      await this.audit.record({
        actorEmail: email,
        workspace: 'access',
        action: 'auth.signInFailed',
        outcome: 'failed',
        statusCode: 401,
        req,
      });
      throw new UnauthorizedException('Wrong email or password');
    }
    if (staff.status !== 'active') {
      await this.audit.record({
        actorEmail: email,
        workspace: 'access',
        action: 'auth.signInSuspended',
        outcome: 'denied',
        statusCode: 403,
        req,
      });
      throw new ForbiddenException(
        'This account is suspended. Ask the platform owner to restore it.',
      );
    }

    if (staff.twoFactorEnabled && staff.twoFactorSecret) {
      return { stage: '2fa', ticket: await this.ticket(staff, '2fa') };
    }
    // First sign-in (or after a reset): set up the authenticator app now.
    const secret = authenticator.generateSecret();
    await this.db
      .update(platformStaff)
      .set({ twoFactorSecret: secret, twoFactorEnabled: false })
      .where(eq(platformStaff.id, staff.id));
    const otpauthUrl = authenticator.keyuri(
      staff.email,
      'Hoomri Console',
      secret,
    );
    return {
      stage: 'enroll',
      ticket: await this.ticket(staff, 'enroll'),
      secret,
      otpauthUrl,
      qrDataUrl: await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 220 }),
    };
  }

  async verifyCode(
    dto: PlatformCodeDto,
    req: Request,
  ): Promise<PlatformSignInStep> {
    const ticket = await this.tokens.verifyPlatformTicket(dto.ticket);
    if (ticket.stage !== '2fa' && ticket.stage !== 'enroll') {
      throw new UnauthorizedException(
        'Start again with your email and password',
      );
    }
    const staff = await this.activeStaff(ticket.sub, ticket.sv);
    if (
      !staff.twoFactorSecret ||
      !authenticator.check(dto.code, staff.twoFactorSecret)
    ) {
      await this.audit.record({
        actor: {
          id: staff.id,
          name: staff.name,
          email: staff.email,
          roleName: staff.roleKey,
        },
        workspace: 'access',
        action: 'auth.wrongCode',
        outcome: 'failed',
        statusCode: 401,
        req,
      });
      throw new UnauthorizedException(
        'That code is wrong or expired. Check the time on your phone and try the newest code.',
      );
    }
    if (ticket.stage === 'enroll') {
      await this.db
        .update(platformStaff)
        .set({ twoFactorEnabled: true })
        .where(eq(platformStaff.id, staff.id));
    }
    if (staff.mustChangePassword) {
      return {
        stage: 'password',
        ticket: await this.ticket(staff, 'password'),
      };
    }
    return this.finish(staff, req, ticket.stage === 'enroll');
  }

  async setFirstPassword(
    dto: PlatformNewPasswordDto,
    req: Request,
  ): Promise<PlatformSignInStep> {
    const ticket = await this.tokens.verifyPlatformTicket(dto.ticket);
    if (ticket.stage !== 'password') {
      throw new UnauthorizedException(
        'Start again with your email and password',
      );
    }
    const staff = await this.activeStaff(ticket.sub, ticket.sv);
    await this.db
      .update(platformStaff)
      .set({
        passwordHash: await bcrypt.hash(dto.password, BCRYPT_ROUNDS),
        mustChangePassword: false,
      })
      .where(eq(platformStaff.id, staff.id));
    return this.finish({ ...staff, mustChangePassword: false }, req, false);
  }

  async changePassword(
    user: PlatformPrincipal,
    dto: PlatformChangePasswordDto,
  ): Promise<{ ok: true }> {
    if (
      user.roleKey === OWNER_ROLE &&
      !(await this.hasStoredPassword(user.id))
    ) {
      throw new BadRequestException(
        "The owner's password is set in the server environment (PLATFORM_ADMIN_PASSWORD).",
      );
    }
    const [row] = await this.db
      .select()
      .from(platformStaff)
      .where(eq(platformStaff.id, user.id))
      .limit(1);
    if (
      !row?.passwordHash ||
      !(await bcrypt.compare(dto.currentPassword, row.passwordHash))
    ) {
      throw new BadRequestException('Your current password is wrong');
    }
    // Other sessions end; the caller gets a fresh token on next sign-in.
    await this.db
      .update(platformStaff)
      .set({
        passwordHash: await bcrypt.hash(dto.newPassword, BCRYPT_ROUNDS),
        sessionVersion: sql`${platformStaff.sessionVersion} + 1`,
      })
      .where(eq(platformStaff.id, user.id));
    return { ok: true };
  }

  async profile(id: string): Promise<PlatformStaffProfile> {
    const [row] = await this.db
      .select({
        id: platformStaff.id,
        name: platformStaff.name,
        email: platformStaff.email,
        roleKey: platformStaff.roleKey,
        roleName: platformRoles.name,
        grants: platformRoles.grants,
      })
      .from(platformStaff)
      .innerJoin(platformRoles, eq(platformRoles.key, platformStaff.roleKey))
      .where(eq(platformStaff.id, id))
      .limit(1);
    if (!row) throw new UnauthorizedException('Session ended');
    const isOwner = row.roleKey === OWNER_ROLE;
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      role: { key: row.roleKey, name: row.roleName },
      grants: isOwner ? OWNER_GRANTS : row.grants,
      isOwner,
    };
  }

  /** Ends every session of the caller (sign out everywhere). */
  async signOutEverywhere(id: string): Promise<{ ok: true }> {
    await this.db
      .update(platformStaff)
      .set({ sessionVersion: sql`${platformStaff.sessionVersion} + 1` })
      .where(eq(platformStaff.id, id));
    return { ok: true };
  }

  private async finish(
    staff: PlatformStaffRow,
    req: Request,
    enrolled: boolean,
  ): Promise<PlatformSignInStep> {
    await this.db
      .update(platformStaff)
      .set({ lastLoginAt: new Date() })
      .where(eq(platformStaff.id, staff.id));
    const admin = await this.profile(staff.id);
    await this.audit.record({
      actor: {
        id: admin.id,
        name: admin.name,
        email: admin.email,
        roleName: admin.role.name,
      },
      workspace: 'access',
      action: enrolled ? 'auth.signedInFirstTime' : 'auth.signedIn',
      req,
    });
    return {
      stage: 'done',
      token: await this.tokens.signPlatformToken(staff),
      admin,
    };
  }

  private async activeStaff(id: string, sv: number): Promise<PlatformStaffRow> {
    const [row] = await this.db
      .select()
      .from(platformStaff)
      .where(eq(platformStaff.id, id))
      .limit(1);
    if (!row || row.status !== 'active' || row.sessionVersion !== sv) {
      throw new UnauthorizedException(
        'Start again with your email and password',
      );
    }
    return row;
  }

  private ticket(
    staff: PlatformStaffRow,
    stage: '2fa' | 'enroll' | 'password',
  ): Promise<string> {
    return this.tokens.signPlatformTicket({
      sub: staff.id,
      stage,
      sv: staff.sessionVersion,
    });
  }

  private async hasStoredPassword(id: string): Promise<boolean> {
    const [row] = await this.db
      .select({ hash: platformStaff.passwordHash })
      .from(platformStaff)
      .where(eq(platformStaff.id, id))
      .limit(1);
    return !!row?.hash;
  }

  /** The owner's row, created on their first sign-in. */
  private async ensureOwner(email: string): Promise<PlatformStaffRow> {
    const [existing] = await this.db
      .select()
      .from(platformStaff)
      .where(eq(platformStaff.email, email))
      .limit(1);
    if (existing) {
      if (
        existing.roleKey === OWNER_ROLE &&
        existing.status === 'active' &&
        !existing.mustChangePassword
      ) {
        return existing;
      }
      // The env credentials always win: whoever holds them is the owner.
      const [row] = await this.db
        .update(platformStaff)
        .set({
          roleKey: OWNER_ROLE,
          status: 'active',
          mustChangePassword: false,
          passwordHash: null,
        })
        .where(eq(platformStaff.id, existing.id))
        .returning();
      return row;
    }
    const [row] = await this.db
      .insert(platformStaff)
      .values({
        name: 'Platform owner',
        email,
        passwordHash: null,
        roleKey: OWNER_ROLE,
        mustChangePassword: false,
      })
      .returning();
    return row;
  }

  private safeEqual(a: string, b: string): boolean {
    const digest = (s: string) => createHash('sha256').update(s).digest();
    return timingSafeEqual(digest(a), digest(b));
  }
}
