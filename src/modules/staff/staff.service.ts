import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'crypto';
import { and, eq } from 'drizzle-orm';
import {
  permissionsForRole,
  type InvitableRole,
} from '../../common/auth/admin-permissions';
import type { AdminPrincipal } from '../../common/types/principal';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import {
  adminInvites,
  adminUsers,
  shops,
  users,
  type AdminInviteRow,
  type AdminUserRow,
  type ShopRow,
} from '../../database/schema';
import type { AdminUserView } from '../auth/admin-auth.service';
import { AdminUsersService } from '../auth/admin-users.service';
import { TokenService } from '../auth/token.service';
import { MailService } from '../mail/mail.service';

const BCRYPT_ROUNDS = 12;
const INVITE_TTL_MS = 24 * 60 * 60 * 1000; // links are valid for 1 day

/** Seller-facing names for the assignable access tiers. */
const ROLE_LABELS: Record<InvitableRole, string> = {
  manager: 'Full access',
  editor: 'Reports + manage items',
  staff: 'Reports + add items',
};

export interface StaffMemberView {
  id: string;
  name: string;
  email: string;
  role: AdminUserRow['role'];
  lastLoginAt: Date | null;
  createdAt: Date;
}

export interface StaffInviteView {
  id: string;
  email: string;
  role: AdminUserRow['role'];
  invitedByName: string | null;
  expiresAt: Date;
  expired: boolean;
  createdAt: Date;
}

export interface InvitePreview {
  shopName: string;
  workspace: string;
  email: string;
  role: AdminUserRow['role'];
  roleLabel: string;
  invitedByName: string | null;
}

export type AcceptInviteResult =
  | { alreadyMember: true; workspace: string }
  | {
      alreadyMember: false;
      adminUser: AdminUserView;
      token: string;
      workspace: string;
    };

/**
 * Shop-console access management: the team roster and the email-invite
 * lifecycle (issue → accept / revoke / resend). Invite links are single-use,
 * expire after 24 hours, and only their SHA-256 hash is stored.
 */
@Injectable()
export class StaffService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly adminUsers: AdminUsersService,
    private readonly tokens: TokenService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  /** Members + pending invites, with the shop owner synthesized on top. */
  async list(shopId: string): Promise<{
    members: (StaffMemberView & { isOwner: boolean })[];
    invites: StaffInviteView[];
  }> {
    const shop = await this.requireShop(shopId);
    const owner = await this.db.query.users.findFirst({
      where: eq(users.id, shop.ownerId),
    });

    // 'owner'-role rows are just a seller's console identity (possibly pinned
    // to another of their shops) — the real owner comes from shops.ownerId.
    const rows = await this.db.query.adminUsers.findMany({
      where: eq(adminUsers.shopId, shopId),
      orderBy: (t, { asc }) => [asc(t.createdAt)],
    });
    const members = rows
      .filter((r) => r.role !== 'owner')
      .map((r) => ({ ...this.toMemberView(r), isOwner: false }));

    if (owner) {
      // The owner's console identity (for last-login), if they've used it.
      const ownerAdmin = owner.email
        ? await this.adminUsers.findByEmail(owner.email)
        : undefined;
      members.unshift({
        id: ownerAdmin?.id ?? owner.id,
        name: owner.name,
        email: owner.email ?? '',
        role: 'owner',
        lastLoginAt: ownerAdmin?.lastLoginAt ?? null,
        createdAt: shop.createdAt,
        isOwner: true,
      });
    }

    const inviteRows = await this.db.query.adminInvites.findMany({
      where: eq(adminInvites.shopId, shopId),
      with: { invitedBy: true },
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    });
    const invites = inviteRows
      .filter((i) => !i.acceptedAt)
      .map((i) => this.toInviteView(i));

    return { members, invites };
  }

  /**
   * Send (or refresh) an invitation. Re-inviting an email that already has a
   * pending invite rotates the token/expiry and updates the role — the old
   * link stops working, effectively a "resend".
   */
  async invite(
    shopId: string,
    inviter: AdminPrincipal,
    email: string,
    role: InvitableRole,
  ): Promise<StaffInviteView> {
    const shop = await this.requireShop(shopId);
    const normalized = email.trim().toLowerCase();

    const owner = await this.db.query.users.findFirst({
      where: eq(users.id, shop.ownerId),
    });
    if (owner?.email?.toLowerCase() === normalized) {
      throw new ConflictException(
        'That email belongs to the shop owner, who already has full access',
      );
    }

    const existing = await this.adminUsers.findByEmail(normalized);
    if (existing && existing.shopId === shopId) {
      throw new ConflictException(
        'This person is already on your team — change their access level instead',
      );
    }
    if (existing) {
      // `admin_users.email` is globally unique, so one console identity can
      // only ever belong to one shop's team.
      throw new ConflictException(
        'This email already has console access on another shop',
      );
    }

    const { token, tokenHash } = this.newToken();
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

    const prior = await this.db.query.adminInvites.findFirst({
      where: and(
        eq(adminInvites.shopId, shopId),
        eq(adminInvites.email, normalized),
      ),
    });
    let row: AdminInviteRow;
    if (prior) {
      [row] = await this.db
        .update(adminInvites)
        .set({
          role,
          tokenHash,
          expiresAt,
          acceptedAt: null,
          invitedById: inviter.id,
          createdAt: new Date(),
        })
        .where(eq(adminInvites.id, prior.id))
        .returning();
    } else {
      [row] = await this.db
        .insert(adminInvites)
        .values({
          shopId,
          email: normalized,
          role,
          tokenHash,
          expiresAt,
          invitedById: inviter.id,
        })
        .returning();
    }

    await this.sendInviteMail(shop, normalized, role, inviter.name, token);
    return this.toInviteView({ ...row, invitedBy: null }, inviter.name);
  }

  /** Rotate the token + expiry of a pending invite and email the link again. */
  async resend(
    shopId: string,
    inviter: AdminPrincipal,
    inviteId: string,
  ): Promise<StaffInviteView> {
    const invite = await this.requireInvite(shopId, inviteId);
    return this.invite(
      shopId,
      inviter,
      invite.email,
      invite.role as InvitableRole,
    );
  }

  async revoke(shopId: string, inviteId: string): Promise<{ ok: true }> {
    await this.requireInvite(shopId, inviteId);
    await this.db.delete(adminInvites).where(eq(adminInvites.id, inviteId));
    return { ok: true };
  }

  async updateRole(
    shopId: string,
    actor: AdminPrincipal,
    memberId: string,
    role: InvitableRole,
  ): Promise<StaffMemberView> {
    const member = await this.requireMember(shopId, actor, memberId);
    const [row] = await this.db
      .update(adminUsers)
      .set({ role })
      .where(eq(adminUsers.id, member.id))
      .returning();
    return this.toMemberView(row);
  }

  async removeMember(
    shopId: string,
    actor: AdminPrincipal,
    memberId: string,
  ): Promise<{ ok: true }> {
    const member = await this.requireMember(shopId, actor, memberId);
    await this.db.delete(adminUsers).where(eq(adminUsers.id, member.id));
    // Also drop the consumed invite so the email can be re-invited later
    // (the (shop, email) unique row would otherwise block or resurrect it).
    await this.db
      .delete(adminInvites)
      .where(
        and(
          eq(adminInvites.shopId, shopId),
          eq(adminInvites.email, member.email),
        ),
      );
    return { ok: true };
  }

  /** Public: what the accept page shows before the invitee fills the form. */
  async preview(token: string): Promise<InvitePreview> {
    const invite = await this.requireValidToken(token);
    const shop = await this.requireShop(invite.shopId);
    return {
      shopName: shop.name,
      workspace: shop.handle,
      email: invite.email,
      role: invite.role,
      roleLabel: ROLE_LABELS[invite.role as InvitableRole] ?? invite.role,
      invitedByName: invite.invitedBy?.name ?? null,
    };
  }

  /**
   * Public: consume the invite. Creates the console account and signs the
   * invitee straight in (same token shape the admin login flow returns).
   */
  async accept(
    token: string,
    name: string,
    password: string,
  ): Promise<AcceptInviteResult> {
    const invite = await this.requireValidToken(token);
    const shop = await this.requireShop(invite.shopId);

    const existing = await this.adminUsers.findByEmail(invite.email);
    if (existing && existing.shopId !== invite.shopId) {
      throw new ConflictException(
        'This email already has console access on another shop',
      );
    }
    if (existing) {
      // Already on this team (e.g. the invite doubled as a role change):
      // apply the invited role, keep their existing password.
      if (existing.role !== 'owner' && existing.role !== invite.role) {
        await this.db
          .update(adminUsers)
          .set({ role: invite.role })
          .where(eq(adminUsers.id, existing.id));
      }
      await this.markAccepted(invite.id);
      return { alreadyMember: true, workspace: shop.handle };
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const admin = await this.adminUsers.create({
      name: name.trim(),
      email: invite.email,
      passwordHash,
      role: invite.role,
      shopId: invite.shopId,
      twoFactorEnabled: false,
    });
    await this.markAccepted(invite.id);
    await this.adminUsers.markLogin(admin.id);

    const jwt = await this.tokens.signAdminToken({
      sub: admin.id,
      email: admin.email,
      name: admin.name,
      role: admin.role,
      shopId: admin.shopId,
      twoFactorVerified: true,
    });
    return {
      alreadyMember: false,
      adminUser: {
        id: admin.id,
        name: admin.name,
        email: admin.email,
        role: admin.role,
        permissions: permissionsForRole(admin.role),
        shopId: admin.shopId,
        twoFactorEnabled: admin.twoFactorEnabled,
      },
      token: jwt,
      workspace: shop.handle,
    };
  }

  /* ── internals ─────────────────────────────────────────────── */

  private newToken(): { token: string; tokenHash: string } {
    const token = randomBytes(32).toString('hex');
    return { token, tokenHash: this.hash(token) };
  }

  private hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private async markAccepted(id: string): Promise<void> {
    await this.db
      .update(adminInvites)
      .set({ acceptedAt: new Date() })
      .where(eq(adminInvites.id, id));
  }

  private async requireShop(shopId: string): Promise<ShopRow> {
    const shop = await this.db.query.shops.findFirst({
      where: eq(shops.id, shopId),
    });
    if (!shop) {
      throw new NotFoundException('Shop not found');
    }
    return shop;
  }

  private async requireInvite(
    shopId: string,
    inviteId: string,
  ): Promise<AdminInviteRow> {
    const invite = await this.db.query.adminInvites.findFirst({
      where: and(
        eq(adminInvites.id, inviteId),
        eq(adminInvites.shopId, shopId),
      ),
    });
    if (!invite || invite.acceptedAt) {
      throw new NotFoundException('Invite not found');
    }
    return invite;
  }

  private async requireValidToken(
    token: string,
  ): Promise<AdminInviteRow & { invitedBy: AdminUserRow | null }> {
    const invite = await this.db.query.adminInvites.findFirst({
      where: eq(adminInvites.tokenHash, this.hash(token || '')),
      with: { invitedBy: true },
    });
    if (!invite || invite.acceptedAt) {
      throw new NotFoundException(
        'This invite link is invalid or was already used',
      );
    }
    if (invite.expiresAt.getTime() < Date.now()) {
      throw new GoneException(
        'This invite link has expired — ask the shop admin to send a new one',
      );
    }
    return invite;
  }

  /** A mutable, non-owner team member of this shop; never the actor themself. */
  private async requireMember(
    shopId: string,
    actor: AdminPrincipal,
    memberId: string,
  ): Promise<AdminUserRow> {
    const member = await this.adminUsers.findById(memberId);
    if (!member || member.shopId !== shopId) {
      throw new NotFoundException('Team member not found');
    }
    if (member.role === 'owner') {
      throw new ForbiddenException("The owner's access can't be changed");
    }
    if (member.id === actor.id) {
      throw new BadRequestException("You can't change your own access");
    }
    return member;
  }

  private toMemberView(row: AdminUserRow): StaffMemberView {
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      role: row.role,
      lastLoginAt: row.lastLoginAt,
      createdAt: row.createdAt,
    };
  }

  private toInviteView(
    row: AdminInviteRow & { invitedBy: AdminUserRow | null },
    inviterName?: string,
  ): StaffInviteView {
    return {
      id: row.id,
      email: row.email,
      role: row.role,
      invitedByName: row.invitedBy?.name ?? inviterName ?? null,
      expiresAt: row.expiresAt,
      expired: row.expiresAt.getTime() < Date.now(),
      createdAt: row.createdAt,
    };
  }

  private async sendInviteMail(
    shop: ShopRow,
    email: string,
    role: InvitableRole,
    inviterName: string,
    token: string,
  ): Promise<void> {
    const webUrl = this.config.getOrThrow<string>('app.webUrl');
    const acceptUrl = `${webUrl.replace(/\/$/, '')}/admin/invite?token=${token}`;
    const roleLabel = ROLE_LABELS[role];

    await this.mail.send({
      to: email,
      subject: `${inviterName} invited you to help run ${shop.name}`,
      text: [
        'Hi,',
        '',
        `${inviterName} has invited you to the admin console of "${shop.name}" (workspace: ${shop.handle}) with "${roleLabel}" access.`,
        'Open the link below to set up your account (it expires in 24 hours):',
        '',
        acceptUrl,
        '',
        "If you weren't expecting this, you can safely ignore this email.",
      ].join('\n'),
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;color:#1a1814">
          <h2 style="font-weight:800">You're invited to ${escapeHtml(shop.name)}</h2>
          <p>${escapeHtml(inviterName)} has invited you to help run
             <b>${escapeHtml(shop.name)}</b> with
             <b>${escapeHtml(roleLabel)}</b> access.</p>
          <p style="margin:28px 0">
            <a href="${acceptUrl}"
               style="background:#1a1814;color:#fff;text-decoration:none;
                      padding:12px 22px;border-radius:10px;font-weight:700;display:inline-block">
              Accept invitation
            </a>
          </p>
          <p style="color:#87827a;font-size:13px">
            This link expires in 24 hours. Your sign-in workspace is
            <b>${escapeHtml(shop.handle)}</b>.
            If you weren't expecting this, you can safely ignore this email.
          </p>
        </div>
      `,
    });
  }
}

/** Shop and inviter names are user-supplied — never interpolate into HTML raw. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
