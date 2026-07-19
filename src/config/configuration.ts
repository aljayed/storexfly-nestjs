import { registerAs } from '@nestjs/config';

/**
 * Namespaced, typed config slices. Inject with `ConfigService` and the token,
 * e.g. `config.get('jwt', { infer: true })`, so call sites stay decoupled from
 * raw env-var names.
 */

export const appConfig = registerAs('app', () => {
  const corsOrigins = (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  return {
    env: process.env.NODE_ENV ?? 'development',
    port: parseInt(process.env.PORT ?? '3000', 10),
    apiPrefix: process.env.API_PREFIX ?? 'api',
    corsOrigins,
    // Public origin of the Vue app — used to build links emailed to users
    // (e.g. the password-reset page). Defaults to the first CORS origin.
    webUrl:
      process.env.PUBLIC_WEB_URL ?? corsOrigins[0] ?? 'http://localhost:5173',
    // Public origin of this API — bKash needs an absolute callback URL that
    // its servers redirect the buyer's browser to.
    apiUrl: process.env.PUBLIC_API_URL ?? 'http://localhost:3000',
  };
});

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

// Platform-admin console (hoomri.com/platform-admin). A single operator
// identity whose credentials come from the environment — no DB row, so the
// console works even on an empty database. Use a strong unique password and
// secret in production.
export const platformAdminConfig = registerAs('platformAdmin', () => ({
  email: (process.env.PLATFORM_ADMIN_EMAIL ?? '').toLowerCase(),
  password: process.env.PLATFORM_ADMIN_PASSWORD as string,
  jwtSecret: process.env.PLATFORM_JWT_SECRET as string,
  jwtExpiresIn: process.env.PLATFORM_JWT_EXPIRES_IN ?? '12h',
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

// Outbound email (SMTP via nodemailer). When host/user/pass are unset the
// MailService falls back to logging the message in non-production, so the
// password-reset flow is testable without a real mail gateway.
export const mailConfig = registerAs('mail', () => ({
  host: process.env.MAIL_HOST ?? '',
  port: parseInt(process.env.MAIL_PORT ?? '587', 10),
  secure: (process.env.MAIL_SECURE ?? 'false') === 'true',
  user: process.env.MAIL_USER ?? '',
  pass: process.env.MAIL_PASS ?? '',
  from: process.env.MAIL_FROM ?? 'Storexfly <no-reply@storexfly.com>',
  get enabled() {
    return Boolean(this.host && this.user && this.pass);
  },
}));

export const throttleConfig = registerAs('throttle', () => ({
  ttl: parseInt(process.env.THROTTLE_TTL ?? '60000', 10),
  limit: parseInt(process.env.THROTTLE_LIMIT ?? '120', 10),
}));

// S3-compatible object storage (Contabo) for user-uploaded media — product
// photos, shop banners, review images, brand logos. Images are uploaded to a
// private bucket and served back through the app's own /media proxy (Nginx
// caches them), so the bucket needs no public access. When unset, StorageService
// stays in passthrough mode and images fall back to inline data URLs.
export const storageConfig = registerAs('storage', () => ({
  endpoint: process.env.S3_ENDPOINT ?? '',
  region: process.env.S3_REGION ?? 'eu2',
  bucket: process.env.S3_BUCKET ?? '',
  accessKeyId: process.env.S3_ACCESS_KEY ?? '',
  secretAccessKey: process.env.S3_SECRET_KEY ?? '',
  // Public path (same-origin) the /media proxy serves objects on.
  publicPrefix: process.env.S3_PUBLIC_PREFIX ?? '/api/media',
  get enabled() {
    return Boolean(
      this.endpoint && this.bucket && this.accessKeyId && this.secretAccessKey,
    );
  },
}));

export const configurations = [
  appConfig,
  databaseConfig,
  jwtConfig,
  adminAuthConfig,
  platformAdminConfig,
  googleConfig,
  mailConfig,
  throttleConfig,
  storageConfig,
];
