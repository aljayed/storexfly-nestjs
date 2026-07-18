/**
 * Trust badges are the small "why buy from us" strip on each product page
 * (packed fresh, fast delivery, …). Sellers can enable/disable and re-word up
 * to {@link MAX_TRUST_BADGES} of them from the shop console; when a shop has
 * never customised them (`trust_badges` is null) the storefront falls back to
 * its own translated defaults.
 */

/** Icons a seller may pick for a badge. Kebab-case keys map to lucide icons on
 *  the storefront/console (see `trustBadgeIcon()` in the Vue app). */
export const TRUST_BADGE_ICONS = [
  'zap',
  'truck',
  'shield-check',
  'rotate-ccw',
  'leaf',
  'package-check',
  'badge-check',
  'clock',
  'heart',
  'gift',
  'sparkles',
  'award',
  'thumbs-up',
  'phone',
  'credit-card',
  'banknote',
] as const;

export type TrustBadgeIcon = (typeof TRUST_BADGE_ICONS)[number];

export interface TrustBadge {
  icon: TrustBadgeIcon;
  title: string;
  subtitle: string;
  enabled: boolean;
}

/** Most a shop can show — keeps the strip to a single tidy row. */
export const MAX_TRUST_BADGES = 4;

/** Field length caps, shared with the DTO validators. */
export const TRUST_BADGE_TITLE_MAX = 40;
export const TRUST_BADGE_SUBTITLE_MAX = 80;
