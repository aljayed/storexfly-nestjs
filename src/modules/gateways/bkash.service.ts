import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  GatewaySettingsService,
  type BkashConfig,
} from './gateway-settings.service';

/** bKash Tokenized Checkout endpoints (v1.2.0-beta). */
const BKASH_BASE = {
  sandbox: 'https://tokenized.sandbox.bka.sh/v1.2.0-beta/tokenized/checkout',
  live: 'https://tokenized.pay.bka.sh/v1.2.0-beta/tokenized/checkout',
};

/** id_token lifetime is 1h; refresh a little early to dodge clock skew. */
const TOKEN_SAFETY_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30_000;

interface GrantTokenResponse {
  statusCode?: string;
  statusMessage?: string;
  id_token?: string;
  expires_in?: string;
}

export interface BkashCreateResult {
  paymentId: string;
  /** Hosted checkout page the buyer is redirected to. */
  bkashUrl: string;
}

export interface BkashExecuteResult {
  ok: boolean;
  trxId?: string;
  transactionStatus?: string;
  /** Amount actually charged, in BDT cents - verified against the order. */
  amountCents?: number;
  statusMessage?: string;
}

/**
 * Thin client for bKash Tokenized (hosted) Checkout. Credentials come from
 * the platform-settings singleton (managed in the platform-admin console);
 * the grant token is cached in memory until shortly before expiry.
 */
@Injectable()
export class BkashService {
  private readonly logger = new Logger(BkashService.name);
  private cachedToken: {
    token: string;
    base: string;
    expiresAt: number;
  } | null = null;

  constructor(private readonly settings: GatewaySettingsService) {}

  /** Whether checkout may offer bKash right now. */
  async isConfigured(): Promise<boolean> {
    return !!(await this.settings.bkashConfig());
  }

  private async requireConfig(): Promise<BkashConfig> {
    const config = await this.settings.bkashConfig();
    if (!config) {
      throw new ServiceUnavailableException(
        'bKash payments are not available right now - please pick another method.',
      );
    }
    return config;
  }

  private baseUrl(config: BkashConfig): string {
    return config.sandbox ? BKASH_BASE.sandbox : BKASH_BASE.live;
  }

  private async post<T>(
    url: string,
    headers: Record<string, string>,
    body: unknown,
  ): Promise<T> {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`bKash HTTP ${res.status} from ${url}`);
    }
    return (await res.json()) as T;
  }

  /** Grant (or reuse) an id_token for the configured environment. */
  private async token(config: BkashConfig): Promise<string> {
    const base = this.baseUrl(config);
    if (
      this.cachedToken &&
      this.cachedToken.base === base &&
      this.cachedToken.expiresAt > Date.now()
    ) {
      return this.cachedToken.token;
    }
    const data = await this.post<GrantTokenResponse>(
      `${base}/token/grant`,
      { username: config.username, password: config.password },
      { app_key: config.appKey, app_secret: config.appSecret },
    );
    if (!data.id_token) {
      throw new Error(
        `bKash token grant failed: ${data.statusCode ?? ''} ${data.statusMessage ?? ''}`,
      );
    }
    const ttlMs = (parseInt(data.expires_in ?? '3600', 10) || 3600) * 1000;
    this.cachedToken = {
      token: data.id_token,
      base,
      expiresAt: Date.now() + ttlMs - TOKEN_SAFETY_MS,
    };
    return data.id_token;
  }

  /**
   * Open a hosted-checkout payment for one order. Returns the URL to send
   * the buyer to; bKash redirects them back to `callbackUrl` with
   * `?paymentID=…&status=success|failure|cancel`.
   */
  async createPayment(input: {
    amountCents: number;
    invoiceNumber: string;
    payerReference: string;
    callbackUrl: string;
  }): Promise<BkashCreateResult> {
    const config = await this.requireConfig();
    try {
      const token = await this.token(config);
      const data = await this.post<{
        statusCode?: string;
        statusMessage?: string;
        paymentID?: string;
        bkashURL?: string;
      }>(
        `${this.baseUrl(config)}/create`,
        { Authorization: token, 'X-APP-Key': config.appKey },
        {
          mode: '0011',
          currency: 'BDT',
          intent: 'sale',
          amount: (input.amountCents / 100).toFixed(2),
          merchantInvoiceNumber: input.invoiceNumber,
          payerReference: input.payerReference.slice(0, 20) || '01',
          callbackURL: input.callbackUrl,
        },
      );
      if (!data.paymentID || !data.bkashURL) {
        throw new Error(
          `bKash create failed: ${data.statusCode ?? ''} ${data.statusMessage ?? ''}`,
        );
      }
      return { paymentId: data.paymentID, bkashUrl: data.bkashURL };
    } catch (err) {
      this.logger.error('bKash create payment failed', err as Error);
      throw new ServiceUnavailableException(
        'Could not reach bKash - please try again or pick another method.',
      );
    }
  }

  /** Capture the money after the buyer approved the payment on bKash. */
  async executePayment(paymentId: string): Promise<BkashExecuteResult> {
    const config = await this.requireConfig();
    try {
      const token = await this.token(config);
      const data = await this.post<{
        statusCode?: string;
        statusMessage?: string;
        trxID?: string;
        transactionStatus?: string;
        amount?: string;
      }>(
        `${this.baseUrl(config)}/execute`,
        { Authorization: token, 'X-APP-Key': config.appKey },
        { paymentID: paymentId },
      );
      const ok =
        data.statusCode === '0000' && data.transactionStatus === 'Completed';
      return {
        ok,
        trxId: data.trxID,
        transactionStatus: data.transactionStatus,
        amountCents: data.amount
          ? Math.round(parseFloat(data.amount) * 100)
          : undefined,
        statusMessage: data.statusMessage,
      };
    } catch (err) {
      this.logger.error(`bKash execute failed for ${paymentId}`, err as Error);
      return { ok: false, statusMessage: 'Could not reach bKash' };
    }
  }
}
