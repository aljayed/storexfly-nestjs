import { registerAs } from '@nestjs/config';

/**
 * Namespaced, typed config slices. Inject with `ConfigService` and the token,
 * e.g. `config.get('jwt', { infer: true })`, so call sites stay decoupled from
 * raw env-var names.
 */

export const appConfig = registerAs('app', () => ({
  env: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '3000', 10),
  apiPrefix: process.env.API_PREFIX ?? 'api',
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
}));

export const databaseConfig = registerAs('database', () => ({
  url: process.env.DATABASE_URL as string,
}));

export const jwtConfig = registerAs('jwt', () => ({
  secret: process.env.JWT_SECRET as string,
  expiresIn: process.env.JWT_EXPIRES_IN ?? '7d',
}));

export const adminAuthConfig = registerAs('adminAuth', () => ({
  jwtSecret: process.env.ADMIN_JWT_SECRET as string,
  jwtExpiresIn: process.env.ADMIN_JWT_EXPIRES_IN ?? '12h',
  ticketSecret: process.env.ADMIN_2FA_TICKET_SECRET as string,
  ticketExpiresIn: process.env.ADMIN_2FA_TICKET_EXPIRES_IN ?? '5m',
}));

export const googleConfig = registerAs('google', () => ({
  clientId: process.env.GOOGLE_CLIENT_ID ?? '',
  clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
  callbackUrl:
    process.env.GOOGLE_CALLBACK_URL ??
    'http://localhost:3000/api/auth/google/callback',
  successRedirect:
    process.env.OAUTH_SUCCESS_REDIRECT ?? 'http://localhost:5173/auth/callback',
  get enabled() {
    return Boolean(this.clientId && this.clientSecret);
  },
}));

export const throttleConfig = registerAs('throttle', () => ({
  ttl: parseInt(process.env.THROTTLE_TTL ?? '60000', 10),
  limit: parseInt(process.env.THROTTLE_LIMIT ?? '120', 10),
}));

export const configurations = [
  appConfig,
  databaseConfig,
  jwtConfig,
  adminAuthConfig,
  googleConfig,
  throttleConfig,
];
