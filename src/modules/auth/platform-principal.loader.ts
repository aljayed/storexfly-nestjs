import { eq } from 'drizzle-orm';
import {
  OWNER_GRANTS,
  OWNER_ROLE,
  type PlatformGrants,
} from '../../common/auth/platform-access';
import type { PlatformPrincipal } from '../../common/types/principal';
import type { DbExecutor } from '../../database/drizzle.types';
import { platformRoles, platformStaff } from '../../database/schema';
import type { PlatformJwtPayload } from './interfaces/jwt-payload.interface';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Turns a verified platform session claim into the live principal: the staff
 * row must still exist, be active, have finished 2-step set-up and carry the
 * same session version. Role grants are read fresh on every request, so a role
 * edit takes effect immediately. Returns null when the session is no longer
 * good (and the caller answers 401).
 */
export async function loadPlatformPrincipal(
  db: DbExecutor,
  payload: PlatformJwtPayload,
): Promise<PlatformPrincipal | null> {
  if (payload?.typ !== 'platform' || !UUID.test(String(payload.sub))) {
    return null;
  }
  const [row] = await db
    .select({
      id: platformStaff.id,
      name: platformStaff.name,
      email: platformStaff.email,
      status: platformStaff.status,
      twoFactorEnabled: platformStaff.twoFactorEnabled,
      mustChangePassword: platformStaff.mustChangePassword,
      sessionVersion: platformStaff.sessionVersion,
      roleKey: platformStaff.roleKey,
      roleName: platformRoles.name,
      grants: platformRoles.grants,
    })
    .from(platformStaff)
    .innerJoin(platformRoles, eq(platformRoles.key, platformStaff.roleKey))
    .where(eq(platformStaff.id, payload.sub))
    .limit(1);
  if (
    !row ||
    row.status !== 'active' ||
    !row.twoFactorEnabled ||
    row.mustChangePassword ||
    row.sessionVersion !== payload.sv
  ) {
    return null;
  }
  const grants: PlatformGrants =
    row.roleKey === OWNER_ROLE ? OWNER_GRANTS : (row.grants ?? {});
  return {
    kind: 'platform',
    id: row.id,
    email: row.email,
    name: row.name,
    roleKey: row.roleKey,
    roleName: row.roleName,
    grants,
  };
}
