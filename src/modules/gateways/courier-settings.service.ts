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

/** What the operator console sees: everything except the secret values. */
export interface CourierSettingsView {
  /** The provider bookings go through; null = no courier configured. */
  active: CourierProvider | null;
  /** When true, shops may only ship through the platform courier. */
  courierRequired: boolean;
  carrybee: {
    enabled: boolean;
    /** false = sandbox.carrybee.com. */
    production: boolean;
    clientId: string | null;
    /** Not a secret on CarryBee's own console either - it shows it in clear. */
    clientContext: string | null;
    hasSecret: boolean;
    hasWebhookSecret: boolean;
    configured: boolean;
  };
  steadfast: {
    enabled: boolean;
    apiKey: string | null;
    hasSecret: boolean;
    configured: boolean;
  };
  pathao: {
    enabled: boolean;
    production: boolean;
    clientId: string | null;
    username: string | null;
    hasSecret: boolean;
    hasPassword: boolean;
    configured: boolean;
  };
}

export interface UpdateCarrybeePatch {
  enabled?: boolean;
  production?: boolean;
  clientId?: string;
  clientSecret?: string;
  clientContext?: string;
  webhookSecret?: string;
}

export interface UpdateSteadfastPatch {
  enabled?: boolean;
  apiKey?: string;
  secretKey?: string;
}

export interface UpdatePathaoPatch {
  enabled?: boolean;
  production?: boolean;
  clientId?: string;
  clientSecret?: string;
  username?: string;
  password?: string;
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

  private carrybeeComplete(row?: PlatformSettingsRow): boolean {
    return !!(
      row?.carrybeeClientId &&
      row.carrybeeClientSecret &&
      row.carrybeeClientContext
    );
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
      return { provider: 'carrybee', config: this.toCarrybeeConfig(row) };
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
   */
  async carrybeeConfig(): Promise<CarrybeeConfig | null> {
    const row = await this.row();
    return this.carrybeeComplete(row) ? this.toCarrybeeConfig(row!) : null;
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

  /** The secret CarryBee must echo on its webhook, or null if unset - in
   *  which case the route rejects everything rather than trusting callers. */
  async carrybeeWebhookSecret(): Promise<string | null> {
    const row = await this.row();
    return row?.carrybeeWebhookSecret?.trim() || null;
  }

  /** Whether shops are confined to the platform courier for fulfilment. */
  async courierRequired(): Promise<boolean> {
    const row = await this.row();
    return row?.courierRequired ?? false;
  }

  private toCarrybeeConfig(row: PlatformSettingsRow): CarrybeeConfig {
    return {
      clientId: row.carrybeeClientId!,
      clientSecret: row.carrybeeClientSecret!,
      clientContext: row.carrybeeClientContext!,
      sandbox: !row.carrybeeProduction,
    };
  }

  private toPathaoConfig(row: PlatformSettingsRow): PathaoConfig {
    return {
      clientId: row.pathaoClientId!,
      clientSecret: row.pathaoClientSecret!,
      username: row.pathaoUsername!,
      password: row.pathaoPassword!,
      sandbox: !row.pathaoProduction,
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
        production: row?.carrybeeProduction ?? false,
        clientId: row?.carrybeeClientId ?? null,
        // Readable on CarryBee's own console too, so hiding it would only
        // leave an operator unable to tell which account is stored.
        clientContext: row?.carrybeeClientContext ?? null,
        hasSecret: !!row?.carrybeeClientSecret,
        hasWebhookSecret: !!row?.carrybeeWebhookSecret,
        configured: this.carrybeeComplete(row),
      },
      steadfast: {
        enabled: row?.steadfastEnabled ?? false,
        apiKey: row?.steadfastApiKey ?? null,
        hasSecret: !!row?.steadfastSecretKey,
        configured: this.steadfastComplete(row),
      },
      pathao: {
        enabled: row?.pathaoEnabled ?? false,
        production: row?.pathaoProduction ?? false,
        clientId: row?.pathaoClientId ?? null,
        username: row?.pathaoUsername ?? null,
        hasSecret: !!row?.pathaoClientSecret,
        hasPassword: !!row?.pathaoPassword,
        configured: this.pathaoComplete(row),
      },
    };
  }

  // ── Writes ──────────────────────────────────────────────────────

  /** Patch CarryBee; omitted secret fields keep their stored values. */
  async updateCarrybee(
    patch: UpdateCarrybeePatch,
  ): Promise<CourierSettingsView> {
    const merged = await this.patch({
      ...(patch.production !== undefined && {
        carrybeeProduction: patch.production,
      }),
      ...(patch.clientId !== undefined && {
        carrybeeClientId: trimOrNull(patch.clientId),
      }),
      ...(patch.clientSecret !== undefined && {
        carrybeeClientSecret: trimOrNull(patch.clientSecret),
      }),
      ...(patch.clientContext !== undefined && {
        carrybeeClientContext: trimOrNull(patch.clientContext),
      }),
      ...(patch.webhookSecret !== undefined && {
        carrybeeWebhookSecret: trimOrNull(patch.webhookSecret),
      }),
    });
    // No pickup store to check for: each shop registers its own on first
    // booking, from its own address.
    await this.setEnabled(
      'carrybee',
      patch.enabled,
      this.carrybeeComplete(merged),
      'Add the CarryBee client ID, secret and context before enabling it.',
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
      ...(patch.production !== undefined && {
        pathaoProduction: patch.production,
      }),
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
    });
    await this.setEnabled(
      'pathao',
      patch.enabled,
      this.pathaoComplete(merged),
      'Add the Pathao credentials before enabling it.',
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
