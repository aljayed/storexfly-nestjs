import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  GatewaySettingsService,
  type SslcommerzConfig,
} from './gateway-settings.service';

/** SSLCommerz hosted checkout (v4) hosts. */
const SSL_BASE = {
  sandbox: 'https://sandbox.sslcommerz.com',
  live: 'https://securepay.sslcommerz.com',
};

const SESSION_PATH = '/gwprocess/v4/api.php';
const VALIDATE_PATH = '/validator/api/validationserverAPI.php';
const REQUEST_TIMEOUT_MS = 30_000;

export interface SslcommerzCustomer {
  name: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  postcode: string;
}

export interface SslcommerzSessionInput {
  /** Amount to collect now, in BDT cents (paisa). */
  amountCents: number;
  /** Our own `tran_id` - what the return leg looks the attempt up by. */
  tranId: string;
  productName: string;
  customer: SslcommerzCustomer;
  successUrl: string;
  failUrl: string;
  cancelUrl: string;
  ipnUrl: string;
}

export interface SslcommerzSessionResult {
  /** Hosted checkout page the buyer is redirected to. */
  gatewayUrl: string;
  sessionKey: string;
}

/**
 * A callback SSLCommerz posts back - to success/fail/cancel, or to the IPN.
 * Only the fields the return leg reads are named; the rest ride along and are
 * still covered by the signature check.
 */
export type SslcommerzCallbackBody = Record<string, string | undefined>;

export interface SslcommerzValidation {
  ok: boolean;
  /** The `tran_id` the gateway says was paid - checked against the attempt. */
  tranId?: string;
  /** SSLCommerz `bank_tran_id`, the receipt + refund reference. */
  bankTranId?: string;
  /** Amount actually collected, in BDT cents - verified against the order. */
  amountCents?: number;
  currency?: string;
  cardType?: string;
  status?: string;
  reason?: string;
}

interface SessionResponse {
  status?: string;
  failedreason?: string;
  sessionkey?: string;
  GatewayPageURL?: string;
  redirectGatewayURL?: string;
}

interface ValidationResponse {
  status?: string;
  tran_id?: string;
  bank_tran_id?: string;
  amount?: string;
  currency?: string;
  currency_type?: string;
  currency_amount?: string;
  card_type?: string;
  error?: string;
  risk_level?: string;
  risk_title?: string;
}

/**
 * Thin client for SSLCommerz hosted checkout. Credentials come from the
 * platform-settings singleton (managed in the platform-admin console) - one
 * store account collects for every shop, so a seller cannot route money
 * around the platform.
 *
 * Unlike bKash there is no token to grant: every call carries the store id
 * and store password, so nothing is cached here. Two calls make the flow -
 * open a session to get the hosted page, then validate the `val_id` the
 * gateway hands back before a single order is marked paid. The redirect and
 * the IPN are both untrusted input; {@link validate} is the only thing that
 * decides whether money actually moved.
 */
@Injectable()
export class SslcommerzService {
  private readonly logger = new Logger(SslcommerzService.name);

  constructor(private readonly settings: GatewaySettingsService) {}

  /** Whether checkout may offer SSLCommerz right now. */
  async isConfigured(): Promise<boolean> {
    return !!(await this.settings.sslcommerzConfig());
  }

  private async requireConfig(): Promise<SslcommerzConfig> {
    const config = await this.settings.sslcommerzConfig();
    if (!config) {
      throw new ServiceUnavailableException(
        'Card payments are not available right now - please pick another method.',
      );
    }
    return config;
  }

  private baseUrl(config: SslcommerzConfig): string {
    return config.sandbox ? SSL_BASE.sandbox : SSL_BASE.live;
  }

  /**
   * Open a hosted-checkout session for one order and return the page to send
   * the buyer to. SSLCommerz then returns them to `successUrl`/`failUrl`/
   * `cancelUrl` as a form POST carrying `tran_id` and `val_id`.
   */
  async createSession(
    input: SslcommerzSessionInput,
  ): Promise<SslcommerzSessionResult> {
    const config = await this.requireConfig();
    const body = new URLSearchParams({
      store_id: config.storeId,
      store_passwd: config.storePassword,
      total_amount: (input.amountCents / 100).toFixed(2),
      currency: 'BDT',
      tran_id: input.tranId,
      success_url: input.successUrl,
      fail_url: input.failUrl,
      cancel_url: input.cancelUrl,
      ipn_url: input.ipnUrl,
      // Every one of these is required by the v4 session API - an empty one
      // comes back as FAILED with `failedreason`, so each has a fallback.
      product_name: input.productName.slice(0, 255) || 'Order',
      product_category: 'general',
      product_profile: 'general',
      shipping_method: 'Courier',
      num_of_item: '1',
      cus_name: input.customer.name.slice(0, 100) || 'Customer',
      cus_email: input.customer.email.slice(0, 100),
      cus_phone: input.customer.phone.slice(0, 20),
      cus_add1: input.customer.address.slice(0, 100) || 'N/A',
      cus_city: input.customer.city.slice(0, 100) || 'N/A',
      cus_postcode: input.customer.postcode.slice(0, 20) || 'N/A',
      cus_country: 'Bangladesh',
      // Shipping mirrors the delivery address: the parcel and the payment
      // record should not disagree about where the order is going.
      ship_name: input.customer.name.slice(0, 100) || 'Customer',
      ship_add1: input.customer.address.slice(0, 100) || 'N/A',
      ship_city: input.customer.city.slice(0, 100) || 'N/A',
      ship_postcode: input.customer.postcode.slice(0, 20) || 'N/A',
      ship_country: 'Bangladesh',
    });

    let data: SessionResponse;
    try {
      const res = await fetch(`${this.baseUrl(config)}${SESSION_PATH}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: body.toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new Error(`SSLCommerz HTTP ${res.status} opening a session`);
      }
      data = (await res.json()) as SessionResponse;
    } catch (err) {
      this.logger.error('SSLCommerz session request failed', err as Error);
      throw new ServiceUnavailableException(
        'Could not reach the card gateway - please try again or pick another method.',
      );
    }

    const gatewayUrl = data.GatewayPageURL || data.redirectGatewayURL;
    if (data.status !== 'SUCCESS' || !gatewayUrl) {
      // A rejected session is the gateway's answer, not a transport fault -
      // log why (bad credentials, a missing field) and refuse the method.
      this.logger.error(
        `SSLCommerz refused the session for ${input.tranId}: ${data.status ?? 'no status'} ${data.failedreason ?? ''}`,
      );
      throw new ServiceUnavailableException(
        'Could not start the card payment - please try again or pick another method.',
      );
    }
    return { gatewayUrl, sessionKey: data.sessionkey ?? '' };
  }

  /**
   * Ask SSLCommerz what really happened, by the `val_id` it handed back. This
   * is the only statement about the money we trust: the browser redirect and
   * the IPN both arrive over the open internet and neither is proof of
   * anything on its own.
   *
   * 'VALID' is a settled payment; 'VALIDATED' is the same answer replayed for
   * a transaction that was already validated once, so both count as paid.
   */
  async validate(valId: string): Promise<SslcommerzValidation> {
    const config = await this.requireConfig();
    const query = new URLSearchParams({
      val_id: valId,
      store_id: config.storeId,
      store_passwd: config.storePassword,
      format: 'json',
      v: '1',
    });
    try {
      const res = await fetch(
        `${this.baseUrl(config)}${VALIDATE_PATH}?${query.toString()}`,
        {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
      if (!res.ok) {
        throw new Error(`SSLCommerz HTTP ${res.status} validating ${valId}`);
      }
      const data = (await res.json()) as ValidationResponse;
      const settled = data.status === 'VALID' || data.status === 'VALIDATED';
      // An unparseable amount is reported as absent rather than as NaN: NaN
      // loses every comparison, so a short-paid check against it would pass.
      const amount = parseFloat(data.amount ?? '');
      return {
        ok: settled,
        tranId: data.tran_id,
        bankTranId: data.bank_tran_id,
        amountCents: Number.isFinite(amount)
          ? Math.round(amount * 100)
          : undefined,
        currency: data.currency,
        cardType: data.card_type,
        status: data.status,
        reason: data.error || data.risk_title,
      };
    } catch (err) {
      this.logger.error(
        `SSLCommerz validation failed for ${valId}`,
        err as Error,
      );
      // Unreachable is not "failed": the caller leaves the attempt open so
      // the IPN or the sweep can settle it rather than voiding a paid order.
      return {
        ok: false,
        status: 'UNREACHABLE',
        reason: 'Gateway unreachable',
      };
    }
  }

  /**
   * Whether a callback really came from SSLCommerz, by the `verify_sign` hash
   * it carries. `verify_key` names the fields that went into it; they are
   * hashed with the md5 of our store password, which only the two of us know.
   *
   * Returns 'unsigned' when the callback carries no signature at all, so the
   * caller can decide what an unsigned message is worth on that route - a
   * forged one can only ever void a pending order, never mark it paid, since
   * marking paid always goes through {@link validate}.
   */
  async verifySignature(
    body: SslcommerzCallbackBody,
  ): Promise<'valid' | 'invalid' | 'unsigned'> {
    const sign = body.verify_sign;
    const keys = body.verify_key;
    if (!sign || !keys) return 'unsigned';
    const config = await this.requireConfig();
    const fields: Record<string, string> = {};
    for (const name of keys.split(',')) {
      const key = name.trim();
      if (key && body[key] !== undefined) fields[key] = body[key];
    }
    fields.store_passwd = md5(config.storePassword);
    const hashString = Object.keys(fields)
      .sort()
      .map((k) => `${k}=${fields[k]}`)
      .join('&');
    return md5(hashString) === sign ? 'valid' : 'invalid';
  }
}

function md5(value: string): string {
  return createHash('md5').update(value).digest('hex');
}
