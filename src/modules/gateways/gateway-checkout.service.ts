import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import { gatewayPayments } from '../../database/schema';
import type { GatewayPaymentRow } from '../../database/schema';
import { BkashService } from './bkash.service';
import { SslcommerzService } from './sslcommerz.service';

/** The gateways that actually collect money (i.e. everything but 'none'). */
export type CollectingGateway = 'bkash' | 'sslcommerz';

/** What a session is collecting for. */
export type PaymentPurpose = 'order' | 'credit_pack';

export interface GatewayCustomer {
  name: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  postcode: string;
}

export interface OpenSessionInput {
  purpose: PaymentPurpose;
  gateway: CollectingGateway;
  /** What to collect now, in paisa. */
  amountCents: number;
  /**
   * Short human handle for this payment ('1043', 'CREDIT'). Rides in the
   * invoice/`tran_id` so the merchant panel row is recognisable next to what
   * it paid for.
   */
  reference: string;
  /** Id of the thing being paid for - makes the minted `tran_id` unique. */
  entityId: string;
  productName: string;
  customer: GatewayCustomer;
  orderId?: string;
  shopId?: string;
  packCode?: string;
  couponCode?: string;
  discountCents?: number;
  refSlug?: string;
}

export interface OpenSessionResult {
  /** Hosted page to send the payer to. */
  paymentUrl: string;
  attempt: GatewayPaymentRow;
}

/**
 * Opens a hosted-checkout session with whichever gateway is collecting, and
 * records the attempt. One place for it because two very different things
 * are paid for through the same pipes: a buyer paying a shop for an order,
 * and a seller paying the platform for sales credit. Both want the same
 * session bookkeeping and the same return leg, so neither should own it.
 *
 * Deliberately knows nothing about what happens on success - granting credit
 * or confirming an order is the settling side's job (PaymentsService). This
 * only gets the payer to the page and leaves a row saying what they went
 * there to do.
 */
@Injectable()
export class GatewayCheckoutService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly bkash: BkashService,
    private readonly sslcommerz: SslcommerzService,
    private readonly config: ConfigService,
  ) {}

  /** Whether one named gateway can collect right now. */
  async isConfigured(gateway: CollectingGateway): Promise<boolean> {
    return gateway === 'bkash'
      ? this.bkash.isConfigured()
      : this.sslcommerz.isConfigured();
  }

  /**
   * Which gateways a payer may currently be offered. Used by the credit-pack
   * screen, where the seller picks one - unlike a storefront checkout, whose
   * choice comes from the shop's own payment-method catalogue.
   */
  async available(): Promise<CollectingGateway[]> {
    const [bkash, ssl] = await Promise.all([
      this.bkash.isConfigured(),
      this.sslcommerz.isConfigured(),
    ]);
    const list: CollectingGateway[] = [];
    if (ssl) list.push('sslcommerz');
    if (bkash) list.push('bkash');
    return list;
  }

  /** Human name for a gateway, for messages and history rows. */
  label(gateway: CollectingGateway): string {
    return gateway === 'bkash' ? 'bKash' : 'SSLCommerz';
  }

  /**
   * Open the session and record the attempt. Throws when the gateway refuses
   * or is unreachable; the caller decides what to unwind.
   */
  async open(input: OpenSessionInput): Promise<OpenSessionResult> {
    if (input.amountCents <= 0) {
      throw new BadRequestException('There is nothing to pay for.');
    }
    if (!(await this.isConfigured(input.gateway))) {
      throw new BadRequestException(
        `${this.label(input.gateway)} payments are temporarily unavailable - please pick another method.`,
      );
    }

    const digits = input.customer.phone.replace(/\D/g, '');
    const invoice = `${input.reference.replace('#', '')}-${input.entityId.slice(0, 8)}`;
    const shared = {
      purpose: input.purpose,
      orderId: input.orderId ?? null,
      shopId: input.shopId ?? null,
      packCode: input.packCode ?? null,
      couponCode: input.couponCode ?? null,
      discountCents: input.discountCents ?? 0,
      refSlug: input.refSlug ?? null,
      amountCents: input.amountCents,
      payerReference: digits.slice(0, 40),
    };

    if (input.gateway === 'bkash') {
      const created = await this.bkash.createPayment({
        amountCents: input.amountCents,
        invoiceNumber: invoice,
        payerReference: digits,
        callbackUrl: this.paymentsUrl('bkash/callback'),
      });
      const [attempt] = await this.db
        .insert(gatewayPayments)
        .values({ ...shared, provider: 'bkash', paymentId: created.paymentId })
        .returning();
      return { paymentUrl: created.bkashUrl, attempt };
    }

    // SSLCommerz takes an id we mint (max 30 chars) instead of handing one
    // back. The invoice prefix keeps it recognisable in the merchant panel;
    // the suffix keeps a retried attempt distinct, which is what the return
    // leg looks up by.
    const tranId = `${invoice}-${Date.now().toString(36)}`
      .slice(0, 30)
      .toUpperCase();
    const session = await this.sslcommerz.createSession({
      amountCents: input.amountCents,
      tranId,
      productName: input.productName,
      customer: input.customer,
      successUrl: this.paymentsUrl('sslcommerz/success'),
      failUrl: this.paymentsUrl('sslcommerz/fail'),
      cancelUrl: this.paymentsUrl('sslcommerz/cancel'),
      ipnUrl: this.paymentsUrl('sslcommerz/ipn'),
    });
    const [attempt] = await this.db
      .insert(gatewayPayments)
      .values({ ...shared, provider: 'sslcommerz', paymentId: tranId })
      .returning();
    return { paymentUrl: session.gatewayUrl, attempt };
  }

  /** Absolute URL of a /payments route - gateways redirect browsers to it. */
  private paymentsUrl(path: string): string {
    const apiUrl =
      this.config.get<string>('app.apiUrl') ?? 'http://localhost:3000';
    const prefix = this.config.get<string>('app.apiPrefix') ?? 'api';
    return `${apiUrl.replace(/\/$/, '')}/${prefix}/payments/${path}`;
  }
}
