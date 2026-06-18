import { plainToInstance, Transform } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
  validateSync,
} from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

/**
 * Strongly-typed view of `process.env`. Validated once at boot — the app
 * refuses to start with a missing/invalid required variable, which is far
 * safer than discovering it on the first request in production.
 */
export class EnvironmentVariables {
  @IsEnum(NodeEnv)
  @IsOptional()
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @IsInt()
  @Min(0)
  @Max(65535)
  @IsOptional()
  @Transform(({ value }) => parseInt(value, 10))
  PORT = 3000;

  @IsString()
  @IsOptional()
  API_PREFIX = 'api';

  @IsString()
  @IsOptional()
  CORS_ORIGINS = 'http://localhost:5173';

  @IsString()
  @IsNotEmpty()
  DATABASE_URL!: string;

  // ── Seller JWT ────────────────────────────────────────────
  @IsString()
  @IsNotEmpty()
  JWT_SECRET!: string;

  @IsString()
  @IsOptional()
  JWT_EXPIRES_IN = '7d';

  // ── Admin JWT (separate scope) ────────────────────────────
  @IsString()
  @IsNotEmpty()
  ADMIN_JWT_SECRET!: string;

  @IsString()
  @IsOptional()
  ADMIN_JWT_EXPIRES_IN = '12h';

  @IsString()
  @IsNotEmpty()
  ADMIN_2FA_TICKET_SECRET!: string;

  @IsString()
  @IsOptional()
  ADMIN_2FA_TICKET_EXPIRES_IN = '5m';

  // ── Platform-admin console (env-based operator identity) ─
  @IsString()
  @IsNotEmpty()
  PLATFORM_ADMIN_EMAIL!: string;

  @IsString()
  @IsNotEmpty()
  PLATFORM_ADMIN_PASSWORD!: string;

  @IsString()
  @IsNotEmpty()
  PLATFORM_JWT_SECRET!: string;

  @IsString()
  @IsOptional()
  PLATFORM_JWT_EXPIRES_IN = '12h';

  // ── Google OAuth (optional) ───────────────────────────────
  @IsString()
  @IsOptional()
  GOOGLE_CLIENT_ID = '';

  @IsString()
  @IsOptional()
  GOOGLE_CLIENT_SECRET = '';

  @IsString()
  @IsOptional()
  GOOGLE_CALLBACK_URL = 'http://localhost:3000/api/auth/google/callback';

  @IsString()
  @IsOptional()
  OAUTH_SUCCESS_REDIRECT = 'http://localhost:5173/auth/callback';

  // ── Outbound email (SMTP, optional) ───────────────────────
  @IsString()
  @IsOptional()
  PUBLIC_WEB_URL = 'http://localhost:5173';

  @IsString()
  @IsOptional()
  MAIL_HOST = '';

  @IsInt()
  @IsOptional()
  @Transform(({ value }) => parseInt(value, 10))
  MAIL_PORT = 587;

  @IsString()
  @IsOptional()
  MAIL_SECURE = 'false';

  @IsString()
  @IsOptional()
  MAIL_USER = '';

  @IsString()
  @IsOptional()
  MAIL_PASS = '';

  @IsString()
  @IsOptional()
  MAIL_FROM = 'Storexfly <no-reply@storexfly.com>';

  // ── Throttling ────────────────────────────────────────────
  @IsInt()
  @IsOptional()
  @Transform(({ value }) => parseInt(value, 10))
  THROTTLE_TTL = 60000;

  @IsInt()
  @IsOptional()
  @Transform(({ value }) => parseInt(value, 10))
  THROTTLE_LIMIT = 120;
}

export function validateEnv(
  config: Record<string, unknown>,
): EnvironmentVariables {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: false,
  });
  const errors = validateSync(validated, {
    skipMissingProperties: false,
    whitelist: false,
  });
  if (errors.length > 0) {
    const detail = errors
      .map((e) => Object.values(e.constraints ?? {}).join(', '))
      .join('; ');
    throw new Error(`Invalid environment configuration: ${detail}`);
  }
  return validated;
}
