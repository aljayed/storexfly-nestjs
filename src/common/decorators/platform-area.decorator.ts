import { SetMetadata } from '@nestjs/common';
import type { PlatformLevel, PlatformWorkspace } from '../auth/platform-access';

export const PLATFORM_AREA_KEY = 'platformArea';

export interface PlatformAreaRule {
  /** Any one of these workspaces satisfies the rule. */
  workspaces: PlatformWorkspace[];
  /** Fixed level; omitted = `view` for reads and `act` for writes. */
  level?: PlatformLevel;
}

/**
 * Names the console workspace a platform route belongs to. Enforced by
 * `PlatformJwtAuthGuard`: GET/HEAD need `view`, anything else `act`, unless a
 * level is given. Put it on the controller and override per handler where a
 * route belongs to another team or needs sign-off (`approve`).
 *
 *   @PlatformArea('finance')
 *   @PlatformArea('finance', 'approve')
 *   @PlatformArea(['finance', 'growth'])   // either team may read it
 *
 * A platform route without one is open to the owner role only.
 */
export const PlatformArea = (
  workspace: PlatformWorkspace | PlatformWorkspace[],
  level?: PlatformLevel,
) =>
  SetMetadata(PLATFORM_AREA_KEY, {
    workspaces: Array.isArray(workspace) ? workspace : [workspace],
    level,
  } satisfies PlatformAreaRule);

/** Any signed-in staff member, whatever their role (own profile, search). */
export const PLATFORM_ANY_STAFF = 'platformAnyStaff';
export const PlatformAnyStaff = () => SetMetadata(PLATFORM_ANY_STAFF, true);
