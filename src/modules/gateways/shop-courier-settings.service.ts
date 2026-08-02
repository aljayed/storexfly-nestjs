import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import {
  shopCouriers,
  type CourierProvider,
  type ShopCourierRow,
} from '../../database/schema';

export interface ShopSteadfastConfig {
  apiKey: string;
  secretKey: string;
}

export interface ShopPathaoConfig {
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
  storeId: string | null;
  sandbox: boolean;
}

export type ActiveCourier =
  | { provider: 'steadfast'; config: ShopSteadfastConfig }
  | { provider: 'pathao'; config: ShopPathaoConfig };

/** What the seller console sees: everything except the secret values. */
export interface ShopCourierSettingsView {
  active: CourierProvider | null;
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

/**
 * Per-shop courier credentials (Steadfast / Pathao), managed by the seller
 * from the console Settings page. Secrets are write-only through the API. At
 * most one provider is enabled per shop - enabling one disables the other -
 * and a shop with neither enabled delivers manually.
 */
@Injectable()
export class ShopCourierSettingsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  private async row(
    shopId: string,
    provider: CourierProvider,
  ): Promise<ShopCourierRow | undefined> {
    return this.db.query.shopCouriers.findFirst({
      where: and(
        eq(shopCouriers.shopId, shopId),
        eq(shopCouriers.provider, provider),
      ),
    });
  }

  private steadfastComplete(row?: ShopCourierRow): boolean {
    return !!(row?.apiKey && row.secretKey);
  }

  private pathaoComplete(row?: ShopCourierRow): boolean {
    return !!(
      row?.clientId &&
      row.clientSecret &&
      row.username &&
      row.password
    );
  }

  /** The provider (with credentials) that bookings should go through. */
  async activeCourier(shopId: string): Promise<ActiveCourier | null> {
    const rows = await this.db.query.shopCouriers.findMany({
      where: eq(shopCouriers.shopId, shopId),
    });
    const steadfast = rows.find((r) => r.provider === 'steadfast');
    if (steadfast?.enabled && this.steadfastComplete(steadfast)) {
      return {
        provider: 'steadfast',
        config: {
          apiKey: steadfast.apiKey!,
          secretKey: steadfast.secretKey!,
        },
      };
    }
    const pathao = rows.find((r) => r.provider === 'pathao');
    if (pathao?.enabled && this.pathaoComplete(pathao)) {
      return { provider: 'pathao', config: this.toPathaoConfig(pathao) };
    }
    return null;
  }

  /** Steadfast credentials even when the provider is disabled (status
   *  refreshes on already-booked parcels keep working after a switch). */
  async steadfastConfig(shopId: string): Promise<ShopSteadfastConfig | null> {
    const row = await this.row(shopId, 'steadfast');
    return this.steadfastComplete(row)
      ? { apiKey: row!.apiKey!, secretKey: row!.secretKey! }
      : null;
  }

  /** Pathao credentials even when the provider is disabled (settings-page
   *  store lookup needs them before the seller can enable). */
  async pathaoConfig(shopId: string): Promise<ShopPathaoConfig | null> {
    const row = await this.row(shopId, 'pathao');
    return this.pathaoComplete(row) ? this.toPathaoConfig(row!) : null;
  }

  private toPathaoConfig(row: ShopCourierRow): ShopPathaoConfig {
    return {
      clientId: row.clientId!,
      clientSecret: row.clientSecret!,
      username: row.username!,
      password: row.password!,
      storeId: row.storeId,
      sandbox: row.sandbox,
    };
  }

  async view(shopId: string): Promise<ShopCourierSettingsView> {
    const rows = await this.db.query.shopCouriers.findMany({
      where: eq(shopCouriers.shopId, shopId),
    });
    const steadfast = rows.find((r) => r.provider === 'steadfast');
    const pathao = rows.find((r) => r.provider === 'pathao');
    return {
      active: steadfast?.enabled
        ? 'steadfast'
        : pathao?.enabled
          ? 'pathao'
          : null,
      steadfast: {
        enabled: steadfast?.enabled ?? false,
        apiKey: steadfast?.apiKey ?? null,
        hasSecret: !!steadfast?.secretKey,
        configured: this.steadfastComplete(steadfast),
      },
      pathao: {
        enabled: pathao?.enabled ?? false,
        sandbox: pathao?.sandbox ?? false,
        clientId: pathao?.clientId ?? null,
        username: pathao?.username ?? null,
        storeId: pathao?.storeId ?? null,
        hasSecret: !!pathao?.clientSecret,
        hasPassword: !!pathao?.password,
        configured: this.pathaoComplete(pathao),
      },
    };
  }

  /** Patch Steadfast; an omitted secret keeps its stored value. */
  async updateSteadfast(
    shopId: string,
    patch: { enabled?: boolean; apiKey?: string; secretKey?: string },
  ): Promise<ShopCourierSettingsView> {
    const merged = await this.upsert(shopId, 'steadfast', {
      ...(patch.apiKey !== undefined && {
        apiKey: patch.apiKey.trim() || null,
      }),
      ...(patch.secretKey !== undefined && {
        secretKey: patch.secretKey.trim() || null,
      }),
    });
    await this.setEnabled(
      shopId,
      'steadfast',
      patch.enabled,
      this.steadfastComplete(merged),
      'Add your Steadfast API key and secret key before enabling it.',
    );
    return this.view(shopId);
  }

  /** Patch Pathao; omitted secret fields keep their stored values. */
  async updatePathao(
    shopId: string,
    patch: {
      enabled?: boolean;
      sandbox?: boolean;
      clientId?: string;
      clientSecret?: string;
      username?: string;
      password?: string;
      storeId?: string;
    },
  ): Promise<ShopCourierSettingsView> {
    const merged = await this.upsert(shopId, 'pathao', {
      ...(patch.sandbox !== undefined && { sandbox: patch.sandbox }),
      ...(patch.clientId !== undefined && {
        clientId: patch.clientId.trim() || null,
      }),
      ...(patch.clientSecret !== undefined && {
        clientSecret: patch.clientSecret.trim() || null,
      }),
      ...(patch.username !== undefined && {
        username: patch.username.trim() || null,
      }),
      ...(patch.password !== undefined && {
        password: patch.password.trim() || null,
      }),
      ...(patch.storeId !== undefined && {
        storeId: patch.storeId.trim() || null,
      }),
    });
    await this.setEnabled(
      shopId,
      'pathao',
      patch.enabled,
      this.pathaoComplete(merged) && !!merged.storeId,
      'Add your Pathao credentials and pick a store before enabling it.',
    );
    return this.view(shopId);
  }

  /** Insert-or-update the provider row and return the merged result. */
  private async upsert(
    shopId: string,
    provider: CourierProvider,
    set: Partial<ShopCourierRow>,
  ): Promise<ShopCourierRow> {
    const existing = await this.row(shopId, provider);
    if (existing) {
      if (Object.keys(set).length === 0) return existing;
      const [row] = await this.db
        .update(shopCouriers)
        .set(set)
        .where(eq(shopCouriers.id, existing.id))
        .returning();
      return row;
    }
    const [row] = await this.db
      .insert(shopCouriers)
      .values({ shopId, provider, ...set })
      .returning();
    return row;
  }

  /** Apply an enable/disable request; enabling turns the other provider off. */
  private async setEnabled(
    shopId: string,
    provider: CourierProvider,
    enabled: boolean | undefined,
    configured: boolean,
    incompleteMessage: string,
  ): Promise<void> {
    if (enabled === undefined) {
      // Wiping a credential of the currently-enabled provider disables it so
      // bookings never run against half a config.
      if (!configured) {
        await this.db
          .update(shopCouriers)
          .set({ enabled: false })
          .where(
            and(
              eq(shopCouriers.shopId, shopId),
              eq(shopCouriers.provider, provider),
            ),
          );
      }
      return;
    }
    if (enabled && !configured) {
      throw new BadRequestException(incompleteMessage);
    }
    if (enabled) {
      await this.db
        .update(shopCouriers)
        .set({ enabled: false })
        .where(eq(shopCouriers.shopId, shopId));
    }
    await this.db
      .update(shopCouriers)
      .set({ enabled })
      .where(
        and(
          eq(shopCouriers.shopId, shopId),
          eq(shopCouriers.provider, provider),
        ),
      );
  }
}
