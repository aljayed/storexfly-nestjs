import { SetMetadata } from '@nestjs/common';
import type { AdminRole } from '../../database/schema/enums';
import type { AdminPermission } from '../auth/admin-permissions';

export type { AdminRole };

export const ROLES_KEY = 'roles';
export const PERMS_KEY = 'perms';

/**
 * Restricts an admin route to specific roles. Enforced by `RolesGuard`, which
 * must run after the admin JWT guard. Omitting it allows any authenticated
 * admin.
 */
export const Roles = (...roles: AdminRole[]) => SetMetadata(ROLES_KEY, roles);

/**
 * Restricts an admin route to roles holding every listed permission (see
 * common/auth/admin-permissions.ts). Also enforced by `RolesGuard`. Prefer
 * this over `@Roles` — routes stay stable as the role→permission map evolves.
 */
export const RequirePerm = (...perms: AdminPermission[]) =>
  SetMetadata(PERMS_KEY, perms);
