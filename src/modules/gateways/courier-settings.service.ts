import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import {
  platformSettings,
  type CourierProvider,
  type PlatformSettingsRow,
} from '../../database/schema';
import type { CarrybeeConfig } from './carrybee.service';
import type { PathaoConfig } from './pathao.service';
import type { SteadfastConfig } from './steadfast.service';

export type ActiveCourier =
  | { provider: 'carrybee'; config: CarrybeeConfig }
  | { provider: 'steadfast'; config: SteadfastConfig }
  | { provider: 'pathao'; config: PathaoConfig };

/** Which of CarryBee's two credential sets a call means. */
export type CarrybeeEnv = 'live' | 'sandbox';

/** One CarryBee environment, secrets reduced to whether they are stored. */
export interface CarrybeeEnvView {
  clientId: string | null;
  /** Not a secret on CarryBee's own console either - it shows it in clear. */
  clientContext: string | null;
  storeId: string | null;
  hasSecret: boolean;
  configured: boolean;
}

/** What the operator console sees: everything except the secret values. */
export interface CourierSettingsView {
  /** The provider bookings go through; null = no courier configured. */
  active: CourierProvider | null;
  /** When true, shops may only ship through the platform courier. */
  courierRequired: boolean;
  carrybee: {
    enabled: boolean;
    /** true = the sandbox pair and sandbox.carrybee.com are in use. */
    sandbox: boolean;
    hasWebhookSecret: boolean;
    /** Whether the *live* environment's credentials are complete. */
    configured: boolean;
    environments: Record<CarrybeeEnv, CarrybeeEnvView>;
  };
  steadfast: {
    enabled: boolean;
    apiKey: string | null;
    hasSecret: boolean;
    configured: boolean;
  };
  pathao: {
    enabled: boolean;
    sandbox: boolean;
    clientId: string | null;
    username: string | null;
    storeId: string | null;
    hasSecret: boolean;
    hasPassword: boolean;
    configured: boolean;
  };
}

/** Credential fields for one environment; omitted secrets keep their value. */
export interface CarrybeeEnvPatch {
  clientId?: string;
  clientSecret?: string;
  clientContext?: string;
  storeId?: string;
}

export interface UpdateCarrybeePatch {
  enabled?: boolean;
  sandbox?: boolean;
  webhookSecret?: string;
  /** Both may be written at once - the console shows both cards. */
  live?: CarrybeeEnvPatch;
  sandboxCreds?: CarrybeeEnvPatch;
}

export interface UpdateSteadfastPatch {
  enabled?: boolean;
  apiKey?: string;
  secretKey?: string;
}

export interface UpdatePathaoPatch {
  enabled?: boolean;
  sandbox?: boolean;
  clientId?: string;
  clientSecret?: string;
  username?: string;
  password?: string;
  storeId?: string;
}

/**
 * The platform's own courier merchant credentials (CarryBee / Steadfast /
 * Pathao), stored on the platform-settings singleton and managed from the
 * operator console. Secrets are write-only through the API: reads expose only
 * whether one is set.
 *
 * Couriers used to be per-shop. They are not any more, and that is the point:
 * a shop booking on its own courier account owns the whole fulfilment record,
 * so it could cancel every order in the console - which is what the sales
 * meter reads - and still deliver and get paid. Booking on the platform's
 * account makes the consignment, not the seller, the source of truth.
 *
 * At most one provider is enabled at a time; enabling one disables the others,
 * so a booking never has to choose.
 */
@Injectable()
export class CourierSettingsService {
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

  // ── Completeness ────────────────────────────────────────────────

  /** Which environment is live right now. */
  private liveEnv(row?: PlatformSettingsRow): CarrybeeEnv {
    return row?.carrybeeSandbox === false ? 'live' : 'sandbox';
  }

  /** The stored triple for one environment, secrets included. */
  private carrybeeCreds(
    row: PlatformSettingsRow,
    env: CarrybeeEnv,
  ): {
    clientId: string | null;
    clientSecret: string | null;
    clientContext: string | null;
    storeId: string | null;
  } {
    return env === 'sandbox'
      ? {
          clientId: row.carrybeeSandboxClientId,
          clientSecret: row.carrybeeSandboxClientSecret,
          clientContext: row.carrybeeSandboxClientContext,
          storeId: row.carrybeeSandboxStoreId,
        }
      : {
          clientId: row.carrybeeClientId,
          clientSecret: row.carrybeeClientSecret,
          clientContext: row.carrybeeClientContext,
          storeId: row.carrybeeStoreId,
        };
  }

  private carrybeeComplete(
    row?: PlatformSettingsRow,
    env?: CarrybeeEnv,
  ): boolean {
    if (!row) return false;
    const c = this.carrybeeCreds(row, env ?? this.liveEnv(row));
    return !!(c.clientId && c.clientSecret && c.clientContext);
  }

  private steadfastComplete(row?: PlatformSettingsRow): boolean {
    return !!(row?.steadfastApiKey && row.steadfastSecretKey);
  }

  private pathaoComplete(row?: PlatformSettingsRow): boolean {
    return !!(
      row?.pathaoClientId &&
      row.pathaoClientSecret &&
      row.pathaoUsername &&
      row.pathaoPassword
    );
  }

  // ── Reads ───────────────────────────────────────────────────────

  /** The provider (with credentials) that bookings should go through. */
  async activeCourier(): Promise<ActiveCourier | null> {
    const row = await this.row();
    if (!row) return null;
    if (row.carrybeeEnabled && this.carrybeeComplete(row)) {
      return {
        provider: 'carrybee',
        config: this.toCarrybeeConfig(row, this.liveEnv(row)),
      };
    }
    if (row.steadfastEnabled && this.steadfastComplete(row)) {
      return {
        provider: 'steadfast',
        config: {
          apiKey: row.steadfastApiKey!,
          secretKey: row.steadfastSecretKey!,
        },
      };
    }
    if (row.pathaoEnabled && this.pathaoComplete(row)) {
      return { provider: 'pathao', config: this.toPathaoConfig(row) };
    }
    return null;
  }

  /**
   * Credentials for one provider even when it is disabled - a parcel already
   * booked on Steadfast still needs tracking after the operator switches the
   * platform over to CarryBee, and the console's store pickers need the
   * credentials before the provider can be enabled at all.
   *
   * `env` overrides which CarryBee credential pair is used, so the console can
   * load stores or test a connection for the environment that isn't live yet.
   * Defaults to whichever one bookings currently run on.
   */
  async carrybeeConfig(env?: CarrybeeEnv): Promise<CarrybeeConfig | null> {
    const row = await this.row();
    if (!row) return null;
    const target = env ?? this.liveEnv(row);
    return this.carrybeeComplete(row, target)
      ? this.toCarrybeeConfig(row, target)
      : null;
  }

  async steadfastConfig(): Promise<SteadfastConfig | null> {
    const row = await this.row();
    return this.steadfastComplete(row)
      ? { apiKey: row!.steadfastApiKey!, secretKey: row!.steadfastSecretKey! }
      : null;
  }

  async pathaoConfig(): Promise<PathaoConfig | null> {
    const row = await this.row();
    return this.pathaoComplete(row) ? this.toPathaoConfig(row!) : null;
  }

  /** The secret CarryBee must echo back on its webhook, or null if unset. */
  async carrybeeWebhookSecret(): Promise<string | null> {
    const row = await this.row();
    return row?.carrybeeWebhookSecret ?? null;
  }

  /** Whether shops are confined to the platform courier for fulfilment. */
  async courierRequired(): Promise<boolean> {
    const row = await this.row();
    return row?.courierRequired ?? false;
  }

  private toCarrybeeConfig(
    row: PlatformSettingsRow,
    env: CarrybeeEnv,
  ): CarrybeeConfig {
    const c = this.carrybeeCreds(row, env);
    return {
      clientId: c.clientId!,
      clientSecret: c.clientSecret!,
      clientContext: c.clientContext!,
      storeId: c.storeId,
      // The host follows the credentials, never the stored flag - otherwise
      // a lookup for the non-live environment would hit the wrong base URL.
      sandbox: env === 'sandbox',
    };
  }

  private toPathaoConfig(row: PlatformSettingsRow): PathaoConfig {
    return {
      clientId: row.pathaoClientId!,
      clientSecret: row.pathaoClientSecret!,
      username: row.pathaoUsername!,
      password: row.pathaoPassword!,
      storeId: row.pathaoStoreId,
      sandbox: row.pathaoSandbox,
    };
  }

  /** One environment's card. The secret is the only value held back - the
   *  client id and context are readable on CarryBee's own console too, and
   *  hiding them would leave an operator unable to tell which account is
   *  stored. */
  private carrybeeEnvView(
    row: PlatformSettingsRow | undefined,
    env: CarrybeeEnv,
  ): CarrybeeEnvView {
    if (!row) {
      return {
        clientId: null,
        clientContext: null,
        storeId: null,
        hasSecret: false,
        configured: false,
      };
    }
    const c = this.carrybeeCreds(row, env);
    return {
      clientId: c.clientId,
      clientContext: c.clientContext,
      storeId: c.storeId,
      hasSecret: !!c.clientSecret,
      configured: this.carrybeeComplete(row, env),
    };
  }

  async view(): Promise<CourierSettingsView> {
    const row = await this.row();
    const active = await this.activeCourier();
    return {
      active: active?.provider ?? null,
      courierRequired: row?.courierRequired ?? false,
      carrybee: {
        enabled: row?.carrybeeEnabled ?? false,
        sandbox: row?.carrybeeSandbox ?? true,
        hasWebhookSecret: !!row?.carrybeeWebhookSecret,
        configured: this.carrybeeComplete(row),
        environments: {
          live: this.carrybeeEnvView(row, 'live'),
          sandbox: this.carrybeeEnvView(row, 'sandbox'),
        },
      },
      steadfast: {
        enabled: row?.steadfastEnabled ?? false,
        apiKey: row?.steadfastApiKey ?? null,
        hasSecret: !!row?.steadfastSecretKey,
        configured: this.steadfastComplete(row),
      },
      pathao: {
        enabled: row?.pathaoEnabled ?? false,
        sandbox: row?.pathaoSandbox ?? false,
        clientId: row?.pathaoClientId ?? null,
        username: row?.pathaoUsername ?? null,
        storeId: row?.pathaoStoreId ?? null,
        hasSecret: !!row?.pathaoClientSecret,
        hasPassword: !!row?.pathaoPassword,
        configured: this.pathaoComplete(row),
      },
    };
  }

  // ── Writes ──────────────────────────────────────────────────────

  /** Patch CarryBee; omitted secret fields keep their stored values. Either
   *  environment's credentials can be written, whichever one is live. */
  async updateCarrybee(
    patch: UpdateCarrybeePatch,
  ): Promise<CourierSettingsView> {
    const merged = await this.patch({
      ...(patch.sandbox !== undefined && { carrybeeSandbox: patch.sandbox }),
      ...(patch.webhookSecret !== undefined && {
        carrybeeWebhookSecret: trimOrNull(patch.webhookSecret),
      }),
      ...envColumns(patch.live, 'live'),
      ...envColumns(patch.sandboxCreds, 'sandbox'),
    });
    // Enabling checks the environment that will actually be used, so a shop
    // is never handed a courier whose live half was never filled in.
    const env = this.liveEnv(merged);
    await this.setEnabled(
      'carrybee',
      patch.enabled,
      this.carrybeeComplete(merged, env) &&
        !!this.carrybeeCreds(merged, env).storeId,
      `Add the CarryBee ${env === 'sandbox' ? 'sandbox' : 'production'} client ID, secret and context, and pick a pickup store, before enabling it.`,
    );
    return this.view();
  }

  /** Patch Steadfast; an omitted secret keeps its stored value. */
  async updateSteadfast(
    patch: UpdateSteadfastPatch,
  ): Promise<CourierSettingsView> {
    const merged = await this.patch({
      ...(patch.apiKey !== undefined && {
        steadfastApiKey: trimOrNull(patch.apiKey),
      }),
      ...(patch.secretKey !== undefined && {
        steadfastSecretKey: trimOrNull(patch.secretKey),
      }),
    });
    await this.setEnabled(
      'steadfast',
      patch.enabled,
      this.steadfastComplete(merged),
      'Add the Steadfast API key and secret key before enabling it.',
    );
    return this.view();
  }

  /** Patch Pathao; omitted secret fields keep their stored values. */
  async updatePathao(patch: UpdatePathaoPatch): Promise<CourierSettingsView> {
    const merged = await this.patch({
      ...(patch.sandbox !== undefined && { pathaoSandbox: patch.sandbox }),
      ...(patch.clientId !== undefined && {
        pathaoClientId: trimOrNull(patch.clientId),
      }),
      ...(patch.clientSecret !== undefined && {
        pathaoClientSecret: trimOrNull(patch.clientSecret),
      }),
      ...(patch.username !== undefined && {
        pathaoUsername: trimOrNull(patch.username),
      }),
      ...(patch.password !== undefined && {
        pathaoPassword: trimOrNull(patch.password),
      }),
      ...(patch.storeId !== undefined && {
        pathaoStoreId: trimOrNull(patch.storeId),
      }),
    });
    await this.setEnabled(
      'pathao',
      patch.enabled,
      this.pathaoComplete(merged) && !!merged.pathaoStoreId,
      'Add the Pathao credentials and pick a store before enabling it.',
    );
    return this.view();
  }

  /**
   * Confine shops to the platform courier, or let them off it again. Turning
   * it on without a working courier would leave every shop unable to ship, so
   * it's refused.
   */
  async setCourierRequired(required: boolean): Promise<CourierSettingsView> {
    if (required && !(await this.activeCourier())) {
      throw new BadRequestException(
        'Enable and configure a courier before requiring shops to ship through it.',
      );
    }
    await this.patch({ courierRequired: required });
    return this.view();
  }

  /** Apply a column patch to the singleton and return the merged row. */
  private async patch(
    set: Partial<PlatformSettingsRow>,
  ): Promise<PlatformSettingsRow> {
    const row = await this.requireRow();
    if (Object.keys(set).length === 0) return row;
    const [updated] = await this.db
      .update(platformSettings)
      .set(set)
      .where(eq(platformSettings.id, row.id))
      .returning();
    return updated;
  }

  /**
   * Apply an enable/disable request. Enabling one provider turns the other two
   * off in the same write, so `activeCourier` never has to break a tie.
   */
  private async setEnabled(
    provider: CourierProvider,
    enabled: boolean | undefined,
    configured: boolean,
    incompleteMessage: string,
  ): Promise<void> {
    if (enabled === undefined) {
      // Wiping a credential of the currently-enabled provider disables it, so
      // bookings never run against half a config.
      if (!configured) {
        await this.patch({ [enabledColumn(provider)]: false });
      }
      return;
    }
    if (enabled && !configured) {
      throw new BadRequestException(incompleteMessage);
    }
    if (!enabled) {
      // Dropping the only courier while shops are confined to it would strand
      // every one of them mid-fulfilment.
      const active = await this.activeCourier();
      if (active?.provider === provider && (await this.courierRequired())) {
        throw new BadRequestException(
          'Shops are currently required to ship through the platform courier - turn that off before disabling the only courier.',
        );
      }
      await this.patch({ [enabledColumn(provider)]: false });
      return;
    }
    await this.patch({
      carrybeeEnabled: provider === 'carrybee',
      steadfastEnabled: provider === 'steadfast',
      pathaoEnabled: provider === 'pathao',
    });
  }
}

function enabledColumn(
  provider: CourierProvider,
): 'carrybeeEnabled' | 'steadfastEnabled' | 'pathaoEnabled' {
  return provider === 'carrybee'
    ? 'carrybeeEnabled'
    : provider === 'steadfast'
      ? 'steadfastEnabled'
      : 'pathaoEnabled';
}

function trimOrNull(raw: string): string | null {
  return raw.trim() || null;
}

/** Map one environment's patch onto its own four columns. */
function envColumns(
  patch: CarrybeeEnvPatch | undefined,
  env: CarrybeeEnv,
): Partial<PlatformSettingsRow> {
  if (!patch) return {};
  const sb = env === 'sandbox';
  return {
    ...(patch.clientId !== undefined && {
      [sb ? 'carrybeeSandboxClientId' : 'carrybeeClientId']: trimOrNull(
        patch.clientId,
      ),
    }),
    ...(patch.clientSecret !== undefined && {
      [sb ? 'carrybeeSandboxClientSecret' : 'carrybeeClientSecret']: trimOrNull(
        patch.clientSecret,
      ),
    }),
    ...(patch.clientContext !== undefined && {
      [sb ? 'carrybeeSandboxClientContext' : 'carrybeeClientContext']:
        trimOrNull(patch.clientContext),
    }),
    ...(patch.storeId !== undefined && {
      [sb ? 'carrybeeSandboxStoreId' : 'carrybeeStoreId']: trimOrNull(
        patch.storeId,
      ),
    }),
  };
}
