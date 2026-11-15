/**
 * Access model of the platform console (platform.hoomri.com).
 *
 * The console is split into workspaces, one per team. A role grants each
 * workspace one level:
 *  - `view`    - read the workspace's pages
 *  - `act`     - work its cases and change its records
 *  - `approve` - additionally sign off the workspace's high-risk actions
 *                (closing a shop, re-pricing the whole platform, …)
 * A workspace missing from a role's grants is invisible to that role.
 *
 * This file is the single source of truth shared by the HTTP guard, the chat
 * token adapter and the payload the Vue console uses to build its menu.
 */
export const PLATFORM_WORKSPACES = [
  'sellers',
  'catalog',
  'orders',
  'support',
  'risk',
  'finance',
  'growth',
  'insights',
  'system',
  'access',
] as const;

export type PlatformWorkspace = (typeof PLATFORM_WORKSPACES)[number];

export const PLATFORM_LEVELS = ['view', 'act', 'approve'] as const;
export type PlatformLevel = (typeof PLATFORM_LEVELS)[number];

/** What a role holds in each workspace it can see. */
export type PlatformGrants = Partial<Record<PlatformWorkspace, PlatformLevel>>;

/** The one role that cannot be edited, deleted or handed out by others. */
export const OWNER_ROLE = 'owner';

export const OWNER_GRANTS: PlatformGrants = Object.fromEntries(
  PLATFORM_WORKSPACES.map((w) => [w, 'approve']),
);

const RANK: Record<PlatformLevel, number> = { view: 1, act: 2, approve: 3 };

/** True when `grants` holds at least `level` in `workspace`. */
export function hasGrant(
  grants: PlatformGrants,
  workspace: PlatformWorkspace,
  level: PlatformLevel,
): boolean {
  const held = grants[workspace];
  return !!held && RANK[held] >= RANK[level];
}

/** Drops unknown workspaces and levels - for role edits coming off the wire. */
export function sanitizeGrants(input: unknown): PlatformGrants {
  const out: PlatformGrants = {};
  if (!input || typeof input !== 'object') return out;
  for (const w of PLATFORM_WORKSPACES) {
    // Own fields only: an inherited (prototype) value is never a grant.
    if (!Object.prototype.hasOwnProperty.call(input, w)) continue;
    const level = (input as Record<string, unknown>)[w];
    if (
      typeof level === 'string' &&
      (PLATFORM_LEVELS as readonly string[]).includes(level)
    ) {
      out[w] = level as PlatformLevel;
    }
  }
  return out;
}
