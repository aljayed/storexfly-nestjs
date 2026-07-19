import { Inject, Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import {
  platformSettings,
  type PlatformSettingsRow,
} from '../../database/schema';

export interface BkashConfig {
  enabled: boolean;
  sandbox: boolean;
  appKey: string;
  appSecret: string;
  username: string;
  password: string;
}

export interface SteadfastConfig {
  enabled: boolean;
  apiKey: string;
  secretKey: string;
}

/** What the platform console sees: everything except the secret values. */
export interface GatewaySettingsView {
  bkash: {
    enabled: boolean;
    sandbox: boolean;
    appKey: string | null;
    username: string | null;
    hasSecret: boolean;
    hasPassword: boolean;
    configured: boolean;
  };
  steadfast: {
    enabled: boolean;
    apiKey: string | null;
    hasSecret: boolean;
    configured: boolean;
  };
}

/**
 * bKash + Steadfast merchant credentials, stored on the platform-settings
 * singleton and managed from the platform-admin console. Secrets are write-
 * only through the API: reads expose only whether one is set.
 */
@Injectable()
export class GatewaySettingsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  private async row(): Promise<PlatformSettingsRow | undefined> {
    return this.db.query.platformSettings.findFirst({
      orderBy: [asc(platformSettings.id)],
    });
  }

  /** The singleton row, created on first write if the seed never ran. */
  private async requireRow(): Promise<PlatformSettingsRow> {
    const existing = await this.row();
    if (existing) return existing;
    const [created] = await this.db
      .insert(platformSettings)
      .values({})
      .returning();
    return created;
  }

  async bkashConfig(): Promise<BkashConfig | null> {
    const row = await this.row();
    if (
      !row?.bkashEnabled ||
      !row.bkashAppKey ||
      !row.bkashAppSecret ||
      !row.bkashUsername ||
      !row.bkashPassword
    ) {
      return null;
    }
    return {
      enabled: true,
      sandbox: row.bkashSandbox,
      appKey: row.bkashAppKey,
      appSecret: row.bkashAppSecret,
      username: row.bkashUsername,
      password: row.bkashPassword,
    };
  }

  async steadfastConfig(): Promise<SteadfastConfig | null> {
    const row = await this.row();
    if (
      !row?.steadfastEnabled ||
      !row.steadfastApiKey ||
      !row.steadfastSecretKey
    ) {
      return null;
    }
    return {
      enabled: true,
      apiKey: row.steadfastApiKey,
      secretKey: row.steadfastSecretKey,
    };
  }

  async view(): Promise<GatewaySettingsView> {
    const row = await this.row();
    return {
      bkash: {
        enabled: row?.bkashEnabled ?? false,
        sandbox: row?.bkashSandbox ?? true,
        appKey: row?.bkashAppKey ?? null,
        username: row?.bkashUsername ?? null,
        hasSecret: !!row?.bkashAppSecret,
        hasPassword: !!row?.bkashPassword,
        configured: !!(
          row?.bkashAppKey &&
          row.bkashAppSecret &&
          row.bkashUsername &&
          row.bkashPassword
        ),
      },
      steadfast: {
        enabled: row?.steadfastEnabled ?? false,
        apiKey: row?.steadfastApiKey ?? null,
        hasSecret: !!row?.steadfastSecretKey,
        configured: !!(row?.steadfastApiKey && row.steadfastSecretKey),
      },
    };
  }

  /** Patch bKash settings; omitted secret fields keep their stored value. */
  async updateBkash(patch: {
    enabled?: boolean;
    sandbox?: boolean;
    appKey?: string;
    appSecret?: string;
    username?: string;
    password?: string;
  }): Promise<GatewaySettingsView> {
    const row = await this.requireRow();
    await this.db
      .update(platformSettings)
      .set({
        ...(patch.enabled !== undefined && { bkashEnabled: patch.enabled }),
        ...(patch.sandbox !== undefined && { bkashSandbox: patch.sandbox }),
        ...(patch.appKey !== undefined && {
          bkashAppKey: patch.appKey.trim() || null,
        }),
        ...(patch.appSecret !== undefined && {
          bkashAppSecret: patch.appSecret.trim() || null,
        }),
        ...(patch.username !== undefined && {
          bkashUsername: patch.username.trim() || null,
        }),
        ...(patch.password !== undefined && {
          bkashPassword: patch.password.trim() || null,
        }),
      })
      .where(eq(platformSettings.id, row.id));
    return this.view();
  }

  /** Patch Steadfast settings; an omitted secret keeps its stored value. */
  async updateSteadfast(patch: {
    enabled?: boolean;
    apiKey?: string;
    secretKey?: string;
  }): Promise<GatewaySettingsView> {
    const row = await this.requireRow();
    await this.db
      .update(platformSettings)
      .set({
        ...(patch.enabled !== undefined && { steadfastEnabled: patch.enabled }),
        ...(patch.apiKey !== undefined && {
          steadfastApiKey: patch.apiKey.trim() || null,
        }),
        ...(patch.secretKey !== undefined && {
          steadfastSecretKey: patch.secretKey.trim() || null,
        }),
      })
      .where(eq(platformSettings.id, row.id));
    return this.view();
  }
}
