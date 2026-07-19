import type { AdminRole } from '../../database/schema/enums';

/**
 * Fine-grained capabilities of the shop admin console. Roles are resolved to
 * permission sets here — the single source of truth shared by the HTTP guard
 * (`RolesGuard`), the chat token adapter and the payloads sent to the Vue
 * console (which drives its nav/route gating off the same strings).
 *
 * Access tiers exposed to sellers when inviting staff:
 *  - `manager`  — full access (orders, customers, settings, settlements, …)
 *  - `editor`   — view reports + add/edit/delete items
 *  - `staff`    — view reports + add items only
 * `owner` is never assignable by invite; it additionally covers the
 * owner-only seller-token flows (business verification / KYC).
 */
export type AdminPermission =
  | 'items.view'
  | 'items.add'
  | 'items.edit'
  | 'items.delete'
  | 'reports.view'
  | 'orders.manage'
  | 'customers.view'
  | 'combos.manage'
  | 'chat.manage'
  | 'settings.manage'
  | 'settlements.view'
  | 'subscription.manage'
  | 'verification.manage'
  | 'team.manage';

const FULL_ACCESS: AdminPermission[] = [
  'items.view',
  'items.add',
  'items.edit',
  'items.delete',
  'reports.view',
  'orders.manage',
  'customers.view',
  'combos.manage',
  'chat.manage',
  'settings.manage',
  'settlements.view',
  'subscription.manage',
  'team.manage',
];

const ROLE_PERMISSIONS: Record<AdminRole, readonly AdminPermission[]> = {
  // Verification (KYC) runs on the owner's seller session, so it stays
  // owner-only even though managers otherwise have full access.
  owner: [...FULL_ACCESS, 'verification.manage'],
  manager: FULL_ACCESS,
  editor: [
    'reports.view',
    'items.view',
    'items.add',
    'items.edit',
    'items.delete',
  ],
  staff: ['reports.view', 'items.view', 'items.add'],
};

/** Roles a shop admin may grant when inviting staff (never `owner`). */
export const INVITABLE_ROLES = ['manager', 'editor', 'staff'] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

export function permissionsForRole(
  role: AdminRole,
): readonly AdminPermission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}

export function roleHasPermission(
  role: AdminRole,
  permission: AdminPermission,
): boolean {
  return permissionsForRole(role).includes(permission);
}
