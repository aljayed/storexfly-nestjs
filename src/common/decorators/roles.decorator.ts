import { SetMetadata } from '@nestjs/common';

export type AdminRole = 'owner' | 'manager' | 'staff';

export const ROLES_KEY = 'roles';

/**
 * Restricts an admin route to specific roles. Enforced by `RolesGuard`, which
 * must run after the admin JWT guard. Omitting it allows any authenticated
 * admin.
 */
export const Roles = (...roles: AdminRole[]) => SetMetadata(ROLES_KEY, roles);
