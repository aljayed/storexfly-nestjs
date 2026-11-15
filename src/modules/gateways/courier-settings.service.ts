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

/** How long the CarryBee registration window stays open once opened. */
const CARRYBEE_REGISTRATION_WINDOW_MS = 15 * 60 * 1000;

export type ActiveCourier = { provider: 'carrybee'; config: CarrybeeConfig };

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
    /** ISO time the registration window shuts, or null when it is shut. */
    registrationOpenUntil: string | null;
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

/**
 * The platform's CarryBee merchant credentials, stored on the platform-settings
 * singleton and managed from the operator console. Secrets are write-only through the API: reads expose only
 * whether one is set.
 *
 * Couriers used to be per-shop. They are not any more, and that is the point:
 * a shop booking on its own courier account owns the whole fulfilment record,
 * so it could cancel every order in the console - which is what the sales
 * meter reads - and still deliver and get paid. Booking on the platform's
 * account makes the consignment, not the seller, the source of truth.
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
      row?.carrybeeClientId?.trim() &&
      row.carrybeeClientSecret?.trim() &&
      row.carrybeeClientContext?.trim()
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
    return null;
  }

  /** Keep tracking existing CarryBee parcels even when new bookings are disabled. */
  async carrybeeConfig(): Promise<CarrybeeConfig | null> {
    const row = await this.row();
    return this.carrybeeComplete(row) ? this.toCarrybeeConfig(row!) : null;
  }

  /** The secret CarryBee must echo on its webhook, or null if unset - in
   *  which case the route rejects everything rather than trusting callers. */
  async carrybeeWebhookSecret(): Promise<string | null> {
    const row = await this.row();
    return row?.carrybeeWebhookSecret?.trim() || null;
  }

  /**
   * Whether the operator is currently expecting CarryBee's registration ping.
   *
   * Their verification POST arrives with no secret header, so answering it
   * means handing the secret to a caller that has proved nothing. That is only
   * acceptable while someone is deliberately standing at the console pressing
   * "Add Webhook", which is what this window represents.
   */
  async carrybeeRegistrationOpen(): Promise<boolean> {
    const row = await this.row();
    const until = row?.carrybeeWebhookRegistrationUntil;
    return !!until && until.getTime() > Date.now();
  }

  /** Open that window. Short by design - it is measured against one button
   *  press on CarryBee's site, not a working session. */
  async openCarrybeeRegistration(): Promise<{ until: string }> {
    if (!(await this.carrybeeWebhookSecret())) {
      throw new BadRequestException(
        'Save the CarryBee webhook secret first - there is nothing for the registration check to answer with.',
      );
    }
    const until = new Date(Date.now() + CARRYBEE_REGISTRATION_WINDOW_MS);
    await this.patch({ carrybeeWebhookRegistrationUntil: until });
    return { until: until.toISOString() };
  }

  /** Shut it early - called the moment a registration ping is answered, so
   *  the door is open for one handshake rather than the whole window. */
  async closeCarrybeeRegistration(): Promise<void> {
    await this.patch({ carrybeeWebhookRegistrationUntil: null });
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
        registrationOpenUntil:
          row?.carrybeeWebhookRegistrationUntil &&
          row.carrybeeWebhookRegistrationUntil.getTime() > Date.now()
            ? row.carrybeeWebhookRegistrationUntil.toISOString()
            : null,
        configured: this.carrybeeComplete(row),
      },
    };
  }

  // ── Writes ──────────────────────────────────────────────────────

  /** Patch CarryBee; omitted secret fields keep their stored values. */
  async updateCarrybee(
    patch: UpdateCarrybeePatch,
  ): Promise<CourierSettingsView> {
    const current = await this.requireRow();
    const changes: Partial<PlatformSettingsRow> = {
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
    };
    const merged = { ...current, ...changes };
    const configured = this.carrybeeComplete(merged);
    const enabled = patch.enabled ?? (current.carrybeeEnabled && configured);
    if (enabled && !configured) {
      throw new BadRequestException(
        'Add the CarryBee client ID, secret and context before enabling it.',
      );
    }
    if (current.courierRequired && !enabled) {
      throw new BadRequestException(
        'Turn off the platform courier requirement before disabling CarryBee or removing its credentials.',
      );
    }
    await this.patch({ ...changes, carrybeeEnabled: enabled });
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
        'Enable and configure CarryBee before requiring shops to ship through it.',
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
}

function trimOrNull(raw: string): string | null {
  return raw.trim() || null;
}
