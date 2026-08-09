import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { and, eq, gte, isNotNull, or, sql } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import {
  orders,
  riskEvents,
  users,
  type RiskEventKind,
} from '../../database/schema';

/** How long a signup or an order keeps counting against the next one. */
export const RISK_WINDOW_HOURS = 12;

/**
 * What a checkout has to satisfy before it is allowed through. Every field is
 * false for the ordinary case - the first order from a person in 12 hours, and
 * every order from a buyer who has taken a delivery before.
 */
export interface CheckoutRisk {
  /** Guest repeating from the same IP *and* device: make them sign in. */
  requireLogin: boolean;
  /** Same phone or email ordering again inside the window: prove the number. */
  requirePhoneVerification: boolean;
  /**
   * Cash on delivery is withheld: this order has to be paid through a
   * gateway. Fake orders cost the sender nothing precisely because COD costs
   * nothing up front, so asking for the money is what makes them stop.
   */
  requirePrepayment: boolean;
  /** Why, for the message the buyer sees and for support to read back. */
  reason?: 'repeat_contact' | 'guest_repeat';
}

export interface SignupRisk {
  /** Second account from one address inside the window: verify the email
   *  before the account exists, rather than after. */
  requireEmailVerification: boolean;
}

interface CheckoutSubject {
  phone?: string | null;
  email?: string | null;
  ip?: string | null;
  device?: string | null;
  accountId?: string | null;
  totalCents?: number;
}

/** Bare national number, the same rule the rest of the platform normalises to. */
function normalizePhone(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\D/g, '').replace(/^880/, '').replace(/^0+/, '');
}

/**
 * Spam and fake-order controls.
 *
 * Deliberately keyed on the person rather than the address. Bangladeshi mobile
 * networks put thousands of subscribers behind one CGNAT address, so an
 * IP-only rule would let the first order on a carrier gateway lock out
 * everyone else behind it. Phone and email identify a buyer; the IP is only
 * ever used together with the device fingerprint, and only for guests, where
 * there is nothing better to go on.
 *
 * Nothing here refuses an order outright. Each rule escalates what the buyer
 * must do - sign in, prove the number, put money down - so a real customer in
 * a hurry always has a way through.
 */
@Injectable()
export class RiskService {
  private readonly secret: string;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    config: ConfigService,
  ) {
    // Falls back to the account JWT secret so a deployment that has not set
    // its own still hashes with something private to it.
    this.secret =
      config.get<string>('risk.hashSecret') ??
      config.getOrThrow<string>('jwt.secret');
  }

  /** Identifiers are stored as HMACs - see the schema comment. */
  private hash(value: string | null | undefined): string | null {
    const v = (value ?? '').trim().toLowerCase();
    if (!v) return null;
    return createHmac('sha256', this.secret).update(v).digest('hex');
  }

  private since(): Date {
    return new Date(Date.now() - RISK_WINDOW_HOURS * 60 * 60 * 1000);
  }

  /**
   * A buyer who has already taken delivery is a real customer, not a spam
   * signal, and is exempt from all of it - they can order as often as they
   * like.
   *
   * Recognised by contact details as well as by session, because a regular
   * who checks out as a guest is still a regular. Delivery is the bar on
   * purpose: placing an order proves nothing, but having taken one means a
   * courier found a real person at a real address.
   */
  private async isTrusted(subject: CheckoutSubject): Promise<boolean> {
    const emails = new Set<string>();
    const phone = normalizePhone(subject.phone);
    if (subject.email) emails.add(subject.email.trim().toLowerCase());
    if (subject.accountId) {
      const account = await this.db.query.users.findFirst({
        where: eq(users.id, subject.accountId),
        columns: { email: true, phone: true },
      });
      if (account?.email) emails.add(account.email.toLowerCase());
    }
    if (!emails.size && !phone) return false;

    // Orders carry no account id - history is matched on the contact details,
    // the same link the profile screen and verified-purchase reviews use.
    const matches = [
      emails.size
        ? sql`lower(${orders.email}) in (${sql.join(
            [...emails].map((e) => sql`${e}`),
            sql`, `,
          )})`
        : undefined,
      phone
        ? sql`regexp_replace(coalesce(${orders.phone}, ''), '\\D', '', 'g') like ${'%' + phone}`
        : undefined,
    ].filter(Boolean);

    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(orders)
      .where(and(eq(orders.status, 'Delivered'), or(...matches)));
    return (row?.n ?? 0) > 0;
  }

  private async count(
    kind: RiskEventKind,
    where: ReturnType<typeof and>,
  ): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(riskEvents)
      .where(and(eq(riskEvents.kind, kind), gte(riskEvents.createdAt, this.since()), where));
    return row?.n ?? 0;
  }

  /**
   * Account creation. The first account from an address in 12 hours is created
   * on the spot, as it is today; the next one has to prove its email first, so
   * a script cannot mint accounts faster than it can read inboxes.
   */
  async assessSignup(ip: string | null | undefined): Promise<SignupRisk> {
    const ipHash = this.hash(ip);
    if (!ipHash) return { requireEmailVerification: false };
    const prior = await this.count('signup', eq(riskEvents.ipHash, ipHash));
    return { requireEmailVerification: prior >= 1 };
  }

  async assessCheckout(subject: CheckoutSubject): Promise<CheckoutRisk> {
    const none: CheckoutRisk = {
      requireLogin: false,
      requirePhoneVerification: false,
      requirePrepayment: false,
    };
    if (await this.isTrusted(subject)) return none;

    const phoneHash = this.hash(normalizePhone(subject.phone));
    const emailHash = this.hash(subject.email);
    const ipHash = this.hash(subject.ip);
    const deviceHash = this.hash(subject.device);

    // Same person ordering again - by either identifier.
    const contactMatch = [
      phoneHash ? eq(riskEvents.phoneHash, phoneHash) : undefined,
      emailHash ? eq(riskEvents.emailHash, emailHash) : undefined,
    ].filter(Boolean);
    const repeatContact = contactMatch.length
      ? await this.count('order', or(...contactMatch))
      : 0;

    // Guests only, and only when the address *and* the device both repeat -
    // one without the other is far too easy to hit by accident.
    const repeatGuest =
      !subject.accountId && ipHash && deviceHash
        ? await this.count(
            'order',
            and(
              eq(riskEvents.ipHash, ipHash),
              eq(riskEvents.deviceHash, deviceHash),
              isNotNull(riskEvents.deviceHash),
            ),
          )
        : 0;

    if (repeatContact >= 1) {
      return {
        requireLogin: false,
        requirePhoneVerification: true,
        requirePrepayment: true,
        reason: 'repeat_contact',
      };
    }
    if (repeatGuest >= 1) {
      return { ...none, requireLogin: true, reason: 'guest_repeat' };
    }
    return none;
  }

  /** Record an attempt so the next one can see it. */
  async record(
    kind: RiskEventKind,
    subject: CheckoutSubject,
  ): Promise<void> {
    await this.db.insert(riskEvents).values({
      kind,
      phoneHash: this.hash(normalizePhone(subject.phone)),
      emailHash: this.hash(subject.email),
      ipHash: this.hash(subject.ip),
      deviceHash: this.hash(subject.device),
      accountId: subject.accountId ?? null,
    });
  }
}
