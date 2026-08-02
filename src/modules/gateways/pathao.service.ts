import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ShopPathaoConfig } from './shop-courier-settings.service';

const PATHAO_BASE = 'https://api-hermes.pathao.com';
const PATHAO_SANDBOX_BASE = 'https://courier-api-sandbox.pathao.com';
const REQUEST_TIMEOUT_MS = 30_000;
// Refresh the cached token a minute before Pathao expires it.
const TOKEN_SKEW_MS = 60_000;

export interface PathaoConsignment {
  consignmentId: string;
  status: string;
  deliveryFeeCents: number | null;
}

export interface PathaoPlace {
  id: number;
  name: string;
}

export interface PathaoStore {
  id: string;
  name: string;
  address: string | null;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

/**
 * Pathao Courier merchant client (api-hermes.pathao.com). Credentials are
 * per-shop (see ShopCourierSettingsService); an issued access token is cached
 * per credential set until shortly before it expires.
 */
@Injectable()
export class PathaoService {
  private readonly logger = new Logger(PathaoService.name);
  private readonly tokens = new Map<string, CachedToken>();

  private base(config: ShopPathaoConfig): string {
    return config.sandbox ? PATHAO_SANDBOX_BASE : PATHAO_BASE;
  }

  private async token(config: ShopPathaoConfig): Promise<string> {
    const key = `${config.sandbox ? 's' : 'p'}:${config.clientId}:${config.username}`;
    const cached = this.tokens.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.token;

    const res = await fetch(`${this.base(config)}/aladdin/api/v1/issue-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: 'password',
        username: config.username,
        password: config.password,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const data = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!res.ok || !data.access_token) {
      this.logger.warn(`Pathao token request failed (HTTP ${res.status})`);
      throw new BadRequestException(
        'Pathao rejected the credentials - check the client ID, secret, email and password.',
      );
    }
    this.tokens.set(key, {
      token: data.access_token,
      expiresAt:
        Date.now() +
        Math.max(0, (data.expires_in ?? 3600) * 1000 - TOKEN_SKEW_MS),
    });
    return data.access_token;
  }

  private async request<T>(
    config: ShopPathaoConfig,
    path: string,
    init?: { method?: string; body?: unknown },
  ): Promise<T> {
    const token = await this.token(config);
    const res = await fetch(`${this.base(config)}${path}`, {
      method: init?.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = (await res.json().catch(() => ({}))) as {
        message?: string;
      };
      throw new Error(
        `Pathao HTTP ${res.status} from ${path}: ${detail.message ?? ''}`,
      );
    }
    return (await res.json()) as T;
  }

  /** Merchant stores registered on the Pathao account (settings picker). */
  async stores(config: ShopPathaoConfig): Promise<PathaoStore[]> {
    const data = await this.request<{
      data?: {
        data?: {
          store_id?: number | string;
          store_name?: string;
          store_address?: string;
        }[];
      };
    }>(config, '/aladdin/api/v1/stores');
    return (data.data?.data ?? [])
      .filter((s) => s.store_id !== undefined)
      .map((s) => ({
        id: String(s.store_id),
        name: s.store_name ?? `Store ${s.store_id}`,
        address: s.store_address ?? null,
      }));
  }

  async cities(config: ShopPathaoConfig): Promise<PathaoPlace[]> {
    const data = await this.request<{
      data?: { data?: { city_id?: number; city_name?: string }[] };
    }>(config, '/aladdin/api/v1/city-list');
    return (data.data?.data ?? [])
      .filter((c) => c.city_id !== undefined)
      .map((c) => ({
        id: c.city_id!,
        name: c.city_name ?? `City ${c.city_id}`,
      }));
  }

  async zones(
    config: ShopPathaoConfig,
    cityId: number,
  ): Promise<PathaoPlace[]> {
    const data = await this.request<{
      data?: { data?: { zone_id?: number; zone_name?: string }[] };
    }>(config, `/aladdin/api/v1/cities/${cityId}/zone-list`);
    return (data.data?.data ?? [])
      .filter((z) => z.zone_id !== undefined)
      .map((z) => ({
        id: z.zone_id!,
        name: z.zone_name ?? `Zone ${z.zone_id}`,
      }));
  }

  async areas(
    config: ShopPathaoConfig,
    zoneId: number,
  ): Promise<PathaoPlace[]> {
    const data = await this.request<{
      data?: { data?: { area_id?: number; area_name?: string }[] };
    }>(config, `/aladdin/api/v1/zones/${zoneId}/area-list`);
    return (data.data?.data ?? [])
      .filter((a) => a.area_id !== undefined)
      .map((a) => ({
        id: a.area_id!,
        name: a.area_name ?? `Area ${a.area_id}`,
      }));
  }

  /**
   * Book one parcel. `codAmountCents` is what the courier collects from the
   * buyer on delivery (0 for prepaid orders). Pathao needs the recipient's
   * city and zone as its own numeric IDs, picked by the seller at booking.
   */
  async createOrder(
    config: ShopPathaoConfig,
    input: {
      invoice: string;
      recipientName: string;
      recipientPhone: string;
      recipientAddress: string;
      cityId: number;
      zoneId: number;
      areaId?: number;
      itemQuantity: number;
      codAmountCents: number;
      note?: string;
    },
  ): Promise<PathaoConsignment> {
    if (!config.storeId) {
      throw new BadRequestException(
        'Pick your Pathao store in Settings before booking.',
      );
    }
    try {
      const data = await this.request<{
        data?: {
          consignment_id?: string;
          order_status?: string;
          delivery_fee?: number;
        };
        message?: string;
      }>(config, '/aladdin/api/v1/orders', {
        method: 'POST',
        body: {
          store_id: Number(config.storeId),
          merchant_order_id: input.invoice,
          recipient_name: input.recipientName.slice(0, 100),
          recipient_phone: toLocalPhone(input.recipientPhone),
          recipient_address: input.recipientAddress.slice(0, 220),
          recipient_city: input.cityId,
          recipient_zone: input.zoneId,
          ...(input.areaId ? { recipient_area: input.areaId } : {}),
          delivery_type: 48, // normal delivery
          item_type: 2, // parcel
          item_quantity: Math.max(1, input.itemQuantity),
          item_weight: '0.5',
          amount_to_collect: Math.round(input.codAmountCents / 100),
          ...(input.note
            ? { special_instruction: input.note.slice(0, 200) }
            : {}),
        },
      });
      const c = data.data;
      if (!c?.consignment_id) {
        throw new Error(`Pathao rejected the booking: ${data.message ?? ''}`);
      }
      return {
        consignmentId: c.consignment_id,
        status: normalizeStatus(c.order_status) ?? 'pending',
        deliveryFeeCents:
          typeof c.delivery_fee === 'number'
            ? Math.round(c.delivery_fee * 100)
            : null,
      };
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      this.logger.error('Pathao booking failed', err as Error);
      throw new ServiceUnavailableException(
        'Could not book the courier - please try again in a moment.',
      );
    }
  }

  /** Current order_status for a consignment, normalized to lowercase. */
  async status(
    config: ShopPathaoConfig,
    consignmentId: string,
  ): Promise<string | null> {
    try {
      const data = await this.request<{
        data?: { order_status?: string };
      }>(
        config,
        `/aladdin/api/v1/orders/${encodeURIComponent(consignmentId)}/info`,
      );
      return normalizeStatus(data.data?.order_status);
    } catch (err) {
      this.logger.warn(
        `Pathao status check failed for ${consignmentId}`,
        err as Error,
      );
      return null;
    }
  }
}

/** Pathao statuses arrive as labels ("Delivered", "In Transit"); store them
 *  in the same lowercase shape Steadfast uses so the UI badges match. */
function normalizeStatus(raw?: string | null): string | null {
  if (!raw) return null;
  return raw.trim().toLowerCase().replace(/\s+/g, '_');
}

/** Pathao expects local "01XXXXXXXXX" numbers, not "+880…" internationals. */
function toLocalPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '').replace(/^880/, '').replace(/^0+/, '');
  return `0${digits}`.slice(0, 11);
}
