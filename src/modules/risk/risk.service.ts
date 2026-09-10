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
 *
 * Nothing here withholds a payment method or refuses an order. A repeat inside
 * the window costs the buyer two taps - sign in, then answer a code - and then
 * they order exactly as they would have. Twelve hours after their last order
 * they are an ordinary buyer again with no steps at all.
 */
export interface CheckoutRisk {
  /** Repeating inside the window as a guest: attach the order to an account. */
  requireLogin: boolean;
  /**
   * Answer an SMS code. Asked once the buyer is signed in, so the two steps
   * arrive in that order rather than at once.
   *
   * Cash on delivery only. It asks about the *delivery number*, because
   * nothing has been collected and that number is the only handle anyone has
   * on whoever is meant to open the door. An order paid for before dispatch
   * has already answered the same question with money, and one that is never
   * paid never becomes an order at all - so it is never asked there.
   */
  requirePhoneVerification: boolean;
  /**
   * Why, for the message the buyer sees and for support to read back.
   * `shop_login_only` is the seller's own door policy rather than anything
   * this service found - checkout merges it in, because to a buyer it is the
   * same "sign in first" step and the wording is the only difference.
   */
  reason?: 'repeat_contact' | 'guest_repeat' | 'shop_login_only';
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
  /**
   * True when this order collects nothing before the parcel is dispatched -
   * plain Cash on Delivery. False for anything that takes money online first,
   * the 15% COD advance included: money that has actually moved is the proof
   * the code would have been standing in for.
   */
  cashOnDelivery?: boolean;
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
 * Nothing here refuses an order, withholds a payment method, or caps how often
 * anyone may buy. A repeat inside the window only asks the buyer to identify
 * themselves - sign in, then answer an SMS code - and the order then proceeds
 * exactly as it would have, cash on delivery included.
 *
 * The code is asked once in an account's life for anything paid online. Cash
 * on delivery is the exception, and asks about the delivery number rather than
 * the account, so a buyer who edits the autofilled number confirms the one
 * they typed; leave it alone and there is still nothing to answer.
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

    // Contact details still count - reusing them is what the check is for -
    // but a signed-in buyer is matched on their account too, so changing the
    // address on the form is not a way straight past it.
    const matches = [
      subject.accountId ? eq(orders.userId, subject.accountId) : undefined,
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
      .where(
        and(
          eq(riskEvents.kind, kind),
          gte(riskEvents.createdAt, this.since()),
          where,
        ),
      );
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

  /**
   * Has this account already answered the question the code step would ask?
   *
   * Cash on delivery only - a prepaid order never reaches here, because money
   * before dispatch answers the same question and this step is not asked.
   *
   * The question is about the number on the form, not the account. Nothing has
   * been collected, the seller is about to pay a courier out of their own
   * pocket, and an account verified against some *other* number says nothing
   * at all about whether anyone will answer at this one. So it asks "is the
   * number this parcel is going to the one this account proved?" - and when
   * the buyer edits the autofilled number, the answer is no and they confirm
   * the new one. Editing it is the whole reason the check exists: an unedited
   * number is already the proved one and costs them nothing.
   */
  private async phoneAlreadyProved(subject: CheckoutSubject): Promise<boolean> {
    const account = await this.db.query.users.findFirst({
      where: eq(users.id, subject.accountId!),
      columns: { phone: true, phoneVerified: true },
    });
    if (!account?.phoneVerified) return false;
    const delivery = normalizePhone(subject.phone);
    return !!delivery && normalizePhone(account.phone) === delivery;
  }

  async assessCheckout(subject: CheckoutSubject): Promise<CheckoutRisk> {
    const none: CheckoutRisk = {
      requireLogin: false,
      requirePhoneVerification: false,
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

    const reason =
      repeatContact >= 1
        ? 'repeat_contact'
        : repeatGuest >= 1
          ? 'guest_repeat'
          : undefined;
    if (!reason) return none;

    /* Money taken before dispatch is its own proof, so it replaces the code.
       A prepaid order that is never actually paid never becomes an order: it
       sits on `pay='Pending'`, is swept, cancelled and restocked, and costs
       nobody anything. There is no repeat-order abuse to prevent, so an SMS
       step on top of the payment is friction that buys nothing - and it is
       friction at the worst possible moment, between a buyer deciding to pay
       and paying. Signing in still applies: the order needs an account to
       hang off, and an email or a Google sign-in is what establishes that.

       Cash on delivery is the opposite case and keeps the code. Nothing has
       been collected, the seller is about to pay a courier out of pocket, and
       the delivery number is the only handle anyone has on whoever is meant
       to open the door. */
    const prepaid = !subject.cashOnDelivery;

    // Two steps, in this order. A guest is asked to sign in first - the code
    // step means little against an account that does not exist yet, and it is
    // the account that carries the proof forward to their next order.
    if (!subject.accountId) {
      return { requireLogin: true, requirePhoneVerification: !prepaid, reason };
    }
    // Signed in, so the code is all that is left - and only when the order is
    // one the code is actually protecting, and the account has not already
    // answered it for this order's shape (see above).
    return {
      requireLogin: false,
      requirePhoneVerification: prepaid
        ? false
        : !(await this.phoneAlreadyProved(subject)),
      reason,
    };
  }

  /** Record an attempt so the next one can see it. */
  async record(kind: RiskEventKind, subject: CheckoutSubject): Promise<void> {
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
