import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ShopSteadfastConfig } from './shop-courier-settings.service';

const STEADFAST_BASE = 'https://portal.packzy.com/api/v1';
const REQUEST_TIMEOUT_MS = 30_000;

export interface SteadfastConsignment {
  consignmentId: string;
  trackingCode: string;
  status: string;
}

/**
 * Steadfast Courier client (portal.packzy.com API). Credentials are per-shop,
 * set by the seller in the console (see ShopCourierSettingsService).
 */
@Injectable()
export class SteadfastService {
  private readonly logger = new Logger(SteadfastService.name);

  private async request<T>(
    config: ShopSteadfastConfig,
    path: string,
    init?: { method?: string; body?: unknown },
  ): Promise<T> {
    const res = await fetch(`${STEADFAST_BASE}${path}`, {
      method: init?.method ?? 'GET',
      headers: {
        'Api-Key': config.apiKey,
        'Secret-Key': config.secretKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`Steadfast HTTP ${res.status} from ${path}`);
    }
    return (await res.json()) as T;
  }

  /**
   * Book one parcel. `codAmountCents` is what the courier collects from the
   * buyer on delivery (0 for prepaid orders).
   */
  async createConsignment(
    config: ShopSteadfastConfig,
    input: {
      invoice: string;
      recipientName: string;
      recipientPhone: string;
      recipientAddress: string;
      codAmountCents: number;
      note?: string;
    },
  ): Promise<SteadfastConsignment> {
    try {
      const data = await this.request<{
        status?: number;
        consignment?: {
          consignment_id?: number | string;
          tracking_code?: string;
          status?: string;
        };
        message?: string;
      }>(config, '/create_order', {
        method: 'POST',
        body: {
          invoice: input.invoice,
          recipient_name: input.recipientName.slice(0, 100),
          recipient_phone: toLocalPhone(input.recipientPhone),
          recipient_address: input.recipientAddress.slice(0, 250),
          cod_amount: Math.round(input.codAmountCents) / 100,
          note: input.note?.slice(0, 200),
        },
      });
      const c = data.consignment;
      if (data.status !== 200 || !c?.consignment_id || !c.tracking_code) {
        throw new Error(
          `Steadfast rejected the booking: ${data.message ?? ''}`,
        );
      }
      return {
        consignmentId: String(c.consignment_id),
        trackingCode: c.tracking_code,
        status: c.status ?? 'in_review',
      };
    } catch (err) {
      this.logger.error('Steadfast booking failed', err as Error);
      throw new ServiceUnavailableException(
        'Could not book the courier - please try again in a moment.',
      );
    }
  }

  /** Current delivery_status for a consignment ('pending', 'delivered', …). */
  async status(
    config: ShopSteadfastConfig,
    consignmentId: string,
  ): Promise<string | null> {
    try {
      const data = await this.request<{
        status?: number;
        delivery_status?: string;
      }>(config, `/status_by_cid/${encodeURIComponent(consignmentId)}`);
      return data.delivery_status ?? null;
    } catch (err) {
      this.logger.warn(
        `Steadfast status check failed for ${consignmentId}`,
        err as Error,
      );
      return null;
    }
  }
}

/** Steadfast expects local "01XXXXXXXXX" numbers, not "+880…" internationals. */
function toLocalPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '').replace(/^880/, '').replace(/^0+/, '');
  return `0${digits}`.slice(0, 11);
}
