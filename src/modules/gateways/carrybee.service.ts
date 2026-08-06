import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';

const CARRYBEE_BASE = 'https://developers.carrybee.com';
const CARRYBEE_SANDBOX_BASE = 'https://sandbox.carrybee.com';
const REQUEST_TIMEOUT_MS = 30_000;

/** CarryBee's own limits, from the API conventions table. */
const MAX_WEIGHT_G = 25_000;
const MIN_WEIGHT_G = 1;
const MAX_QUANTITY = 200;
const MAX_COLLECTABLE_TAKA = 100_000;
/** Fallback parcel weight when a shop tracks none, in grams. */
const DEFAULT_WEIGHT_G = 500;

/** delivery_type / product_type codes CarryBee expects. */
const DELIVERY_TYPE_NORMAL = 1;
const PRODUCT_TYPE_PARCEL = 1;

export interface CarrybeeConfig {
  clientId: string;
  clientSecret: string;
  clientContext: string;
  /** Pickup store parcels are collected from; required to book. */
  storeId: string | null;
  sandbox: boolean;
}

export interface CarrybeePlace {
  id: number;
  name: string;
}

export interface CarrybeeStore {
  id: string;
  name: string;
  address: string | null;
  isActive: boolean;
  isApproved: boolean;
}

export interface CarrybeeConsignment {
  consignmentId: string;
  /** Taka figures come back as strings; both are converted to cents. */
  deliveryFeeCents: number | null;
  codFeeCents: number | null;
}

export interface CarrybeeOrderDetails {
  consignmentId: string;
  status: string | null;
  collectedCents: number | null;
  deliveryFeeCents: number | null;
  codFeeCents: number | null;
  reason: string | null;
  paymentStatus: string | null;
  updatedAt: Date | null;
}

/**
 * CarryBee Delivery API client (developers.carrybee.com, v2). Credentials are
 * the platform's own, held on `platform_settings` and managed from the
 * operator console - never a seller's (see CourierSettingsService).
 *
 * Every call carries the Client-ID / Client-Secret / Client-Context triple;
 * there is no token exchange to cache.
 */
@Injectable()
export class CarrybeeService {
  private readonly logger = new Logger(CarrybeeService.name);

  private base(config: CarrybeeConfig): string {
    return config.sandbox ? CARRYBEE_SANDBOX_BASE : CARRYBEE_BASE;
  }

  private async request<T>(
    config: CarrybeeConfig,
    path: string,
    init?: { method?: string; body?: unknown },
  ): Promise<T> {
    const res = await fetch(`${this.base(config)}${path}`, {
      method: init?.method ?? 'GET',
      headers: {
        'Client-ID': config.clientId,
        'Client-Secret': config.clientSecret,
        'Client-Context': config.clientContext,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const payload = (await res.json().catch(() => ({}))) as {
      error?: boolean;
      message?: string;
      causes?: Record<string, { type?: string }[]>;
    };
    if (!res.ok || payload.error) {
      throw new Error(
        `CarryBee HTTP ${res.status} from ${path}: ${describe(payload)}`,
      );
    }
    return payload as T;
  }

  // ── Location catalog ────────────────────────────────────────────

  async cities(config: CarrybeeConfig): Promise<CarrybeePlace[]> {
    const data = await this.request<{
      data?: { cities?: { id?: number; name?: string }[] };
    }>(config, '/api/v2/cities');
    return toPlaces(data.data?.cities);
  }

  async zones(
    config: CarrybeeConfig,
    cityId: number,
  ): Promise<CarrybeePlace[]> {
    const data = await this.request<{
      data?: { zones?: { id?: number; name?: string }[] };
    }>(config, `/api/v2/cities/${cityId}/zones`);
    return toPlaces(data.data?.zones);
  }

  async areas(
    config: CarrybeeConfig,
    cityId: number,
    zoneId: number,
  ): Promise<CarrybeePlace[]> {
    const data = await this.request<{
      data?: { areas?: { id?: number; name?: string }[] };
    }>(config, `/api/v2/cities/${cityId}/zones/${zoneId}/areas`);
    return toPlaces(data.data?.areas);
  }

  /**
   * Free-text search across the catalog - what the booking modal uses so a
   * seller can type "Uttara" instead of walking city → zone → area.
   */
  async suggestAreas(
    config: CarrybeeConfig,
    search: string,
  ): Promise<
    {
      cityId: number;
      cityName: string;
      zoneId: number;
      zoneName: string;
      areaId: number | null;
      areaName: string | null;
    }[]
  > {
    if (search.trim().length < 3) return [];
    const data = await this.request<{
      data?: {
        items?: {
          city_id?: number;
          city_name?: string;
          zone_id?: number;
          zone_name?: string;
          area_id?: number;
          area_name?: string;
        }[];
      };
    }>(
      config,
      `/api/v2/area-suggestion?search=${encodeURIComponent(search.trim())}`,
    );
    return (data.data?.items ?? [])
      .filter((i) => i.city_id !== undefined && i.zone_id !== undefined)
      .map((i) => ({
        cityId: i.city_id!,
        cityName: i.city_name ?? `City ${i.city_id}`,
        zoneId: i.zone_id!,
        zoneName: i.zone_name ?? `Zone ${i.zone_id}`,
        areaId: i.area_id ?? null,
        areaName: i.area_name ?? null,
      }));
  }

  /** Resolve a written address to CarryBee's city/zone ids. */
  async resolveAddress(
    config: CarrybeeConfig,
    query: string,
  ): Promise<{ cityId: number; zoneId: number } | null> {
    // CarryBee rejects anything shorter, and a short address would resolve to
    // junk anyway - the caller falls back to the manual picker.
    if (query.trim().length < 10) return null;
    try {
      const data = await this.request<{
        data?: { city_id?: number; zone_id?: number };
      }>(config, '/api/v2/address-details', {
        method: 'POST',
        body: { query: query.trim() },
      });
      const d = data.data;
      return d?.city_id && d.zone_id
        ? { cityId: d.city_id, zoneId: d.zone_id }
        : null;
    } catch (err) {
      // An unresolvable address is normal, not an outage - the seller picks
      // the city and zone by hand instead.
      this.logger.debug(`CarryBee address lookup failed: ${String(err)}`);
      return null;
    }
  }

  // ── Pickup stores ───────────────────────────────────────────────

  async stores(config: CarrybeeConfig): Promise<CarrybeeStore[]> {
    const data = await this.request<{
      data?: {
        stores?: {
          id?: string;
          name?: string;
          address?: string;
          is_active?: boolean;
          is_approved?: boolean;
        }[];
      };
    }>(config, '/api/v2/stores');
    return (data.data?.stores ?? [])
      .filter((s) => !!s.id)
      .map((s) => ({
        id: String(s.id),
        name: s.name ?? `Store ${s.id}`,
        address: s.address ?? null,
        isActive: s.is_active ?? true,
        isApproved: s.is_approved ?? false,
      }));
  }

  /** Register a pickup store. CarryBee returns no body, so the caller
   *  re-reads the store list to find the new id. */
  async createStore(
    config: CarrybeeConfig,
    input: {
      name: string;
      contactPersonName: string;
      contactPersonNumber: string;
      address: string;
      cityId: number;
      zoneId: number;
      areaId: number;
    },
  ): Promise<void> {
    await this.request(config, '/api/v2/stores', {
      method: 'POST',
      body: {
        name: input.name.slice(0, 30),
        contact_person_name: input.contactPersonName.slice(0, 30),
        contact_person_number: toLocalPhone(input.contactPersonNumber),
        address: input.address.slice(0, 100),
        city_id: input.cityId,
        zone_id: input.zoneId,
        area_id: input.areaId,
      },
    });
  }

  // ── Shipments ───────────────────────────────────────────────────

  /**
   * Book one parcel. `codAmountCents` is what CarryBee collects at the door
   * (0 for prepaid orders); it goes over the wire in whole Taka, which is the
   * only unit the API accepts.
   */
  async createOrder(
    config: CarrybeeConfig,
    input: {
      merchantOrderId: string;
      recipientName: string;
      recipientPhone: string;
      recipientAddress: string;
      cityId: number;
      zoneId: number;
      areaId?: number;
      itemQuantity: number;
      itemWeightGrams?: number;
      codAmountCents: number;
      note?: string;
      description?: string;
    },
  ): Promise<CarrybeeConsignment> {
    if (!config.storeId) {
      throw new BadRequestException(
        'Pick the CarryBee pickup store in the platform console before booking.',
      );
    }
    // CarryBee caps a collectable at ৳1,00,000. Silently sending less would
    // hand the seller a parcel that collects the wrong money, so refuse.
    const codTaka = Math.round(input.codAmountCents / 100);
    if (codTaka > MAX_COLLECTABLE_TAKA) {
      throw new BadRequestException(
        `CarryBee collects at most ৳${MAX_COLLECTABLE_TAKA.toLocaleString('en-BD')} on delivery - take payment for this order online instead.`,
      );
    }
    try {
      const data = await this.request<{
        data?: {
          order?: {
            consignment_id?: string;
            cod_fee?: number | string;
            delivery_fee?: number | string;
          };
        };
        message?: string;
      }>(config, '/api/v2/orders', {
        method: 'POST',
        body: {
          store_id: config.storeId,
          merchant_order_id: input.merchantOrderId.slice(0, 49),
          delivery_type: DELIVERY_TYPE_NORMAL,
          product_type: PRODUCT_TYPE_PARCEL,
          recipient_name: input.recipientName.slice(0, 99),
          recipient_phone: toLocalPhone(input.recipientPhone),
          recipient_address: padAddress(input.recipientAddress),
          city_id: input.cityId,
          zone_id: input.zoneId,
          ...(input.areaId ? { area_id: input.areaId } : {}),
          item_weight: clamp(
            input.itemWeightGrams ?? DEFAULT_WEIGHT_G,
            MIN_WEIGHT_G,
            MAX_WEIGHT_G,
          ),
          item_quantity: clamp(input.itemQuantity, 1, MAX_QUANTITY),
          collectable_amount: Math.max(0, codTaka),
          ...(input.note
            ? { special_instruction: input.note.slice(0, 254) }
            : {}),
          ...(input.description
            ? { product_description: input.description.slice(0, 254) }
            : {}),
        },
      });
      const order = data.data?.order;
      if (!order?.consignment_id) {
        throw new Error(`CarryBee rejected the booking: ${data.message ?? ''}`);
      }
      return {
        consignmentId: String(order.consignment_id),
        deliveryFeeCents: takaToCents(order.delivery_fee),
        codFeeCents: takaToCents(order.cod_fee),
      };
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      this.logger.error('CarryBee booking failed', err as Error);
      throw new ServiceUnavailableException(
        'Could not book the courier - please try again in a moment.',
      );
    }
  }

  /** Current state of a consignment; null when the lookup fails. */
  async details(
    config: CarrybeeConfig,
    consignmentId: string,
  ): Promise<CarrybeeOrderDetails | null> {
    try {
      const data = await this.request<{
        data?: {
          consignment_id?: string;
          transfer_status?: string;
          collected_amount?: number | string;
          delivery_fee?: number | string;
          cod_fee?: number | string;
          reason?: string;
          payment_status?: string;
          updated_at?: string;
        };
      }>(config, `/api/v2/orders/${encodeURIComponent(consignmentId)}/details`);
      const d = data.data;
      if (!d) return null;
      const updatedAt = d.updated_at ? new Date(d.updated_at) : null;
      return {
        consignmentId: String(d.consignment_id ?? consignmentId),
        status: normalizeStatus(d.transfer_status),
        collectedCents: takaToCents(d.collected_amount),
        deliveryFeeCents: takaToCents(d.delivery_fee),
        codFeeCents: takaToCents(d.cod_fee),
        reason: d.reason?.slice(0, 255) ?? null,
        paymentStatus: normalizeStatus(d.payment_status),
        updatedAt:
          updatedAt && !Number.isNaN(updatedAt.getTime()) ? updatedAt : null,
      };
    } catch (err) {
      this.logger.warn(
        `CarryBee status check failed for ${consignmentId}`,
        err as Error,
      );
      return null;
    }
  }

  /** Cancel a consignment that hasn't been picked up yet. */
  async cancelOrder(
    config: CarrybeeConfig,
    consignmentId: string,
    reason: string,
  ): Promise<void> {
    try {
      await this.request(
        config,
        `/api/v2/orders/${encodeURIComponent(consignmentId)}/cancel`,
        {
          method: 'POST',
          body: { cancellation_reason: reason.slice(0, 199) },
        },
      );
    } catch (err) {
      this.logger.error(
        `CarryBee cancellation failed for ${consignmentId}`,
        err as Error,
      );
      throw new ServiceUnavailableException(
        'Could not cancel the parcel with the courier - try again, or cancel it from the CarryBee panel.',
      );
    }
  }

  /** Cheap credential check for the console's "test connection" button. */
  async verify(config: CarrybeeConfig): Promise<void> {
    try {
      await this.request(config, '/api/v2/cities');
    } catch (err) {
      this.logger.warn(`CarryBee credential check failed: ${String(err)}`);
      throw new BadRequestException(
        'CarryBee rejected these credentials - check the client ID, secret and context, and that they match the selected environment.',
      );
    }
  }
}

/** Pull a readable line out of either error shape the API returns. */
function describe(payload: {
  message?: string;
  causes?: Record<string, { type?: string }[]>;
}): string {
  if (!payload.causes) return payload.message ?? '';
  const fields = Object.entries(payload.causes)
    .map(
      ([field, issues]) => `${field} (${issues.map((i) => i.type).join(', ')})`,
    )
    .join('; ');
  return `${payload.message ?? 'Validation error'}: ${fields}`;
}

function toPlaces(
  raw: { id?: number; name?: string }[] | undefined,
): CarrybeePlace[] {
  return (raw ?? [])
    .filter((r) => r.id !== undefined)
    .map((r) => ({ id: r.id!, name: r.name ?? `#${r.id}` }));
}

/** Taka in, cents out. The API returns money as either a number or a string. */
function takaToCents(raw: number | string | undefined | null): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const value = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(value) ? Math.round(value * 100) : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * CarryBee requires 10-200 characters of address. Short-but-real addresses
 * ("Gulshan 1") would 422 the booking, so pad rather than reject; the city and
 * zone ids are what actually route the parcel.
 */
function padAddress(raw: string): string {
  const trimmed = raw.trim().slice(0, 200);
  return trimmed.length >= 10 ? trimmed : `${trimmed} (address as given)`;
}

/** Statuses arrive as labels; store them lowercase-underscored so the UI
 *  badges match the shape Steadfast and Pathao already use. */
function normalizeStatus(raw?: string | null): string | null {
  if (!raw) return null;
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

/** CarryBee expects local "01XXXXXXXXX" numbers, not "+880…" internationals. */
function toLocalPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '').replace(/^880/, '').replace(/^0+/, '');
  return `0${digits}`.slice(0, 11);
}
