import { SetMetadata } from '@nestjs/common';

export const STOREFRONT_SESSION_KEY = 'storefrontSession';

/**
 * Marks a route (or a whole controller) as reachable by a `storefront`-scoped
 * session - an account created by the "create my account" tick at checkout,
 * which has proved neither an email nor a phone number.
 *
 * The allowlist is deliberately fail-closed: {@link SessionScopeGuard} refuses
 * every other authenticated route for those sessions, so a new seller-side
 * endpoint is out of reach by default rather than by remembering to guard it.
 * Shopping, reviewing, chatting and managing your own orders live here;
 * anything that runs a business does not.
 */
export const StorefrontSession = () =>
  SetMetadata(STOREFRONT_SESSION_KEY, true);
