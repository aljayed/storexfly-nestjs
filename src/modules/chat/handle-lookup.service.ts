import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import { shops, users } from '../../database/schema';

/**
 * Who a handle belongs to.
 *
 * `shop` is a storefront, and is also how a seller is reachable: one person,
 * one public name, whichever side of the platform they are standing on. An
 * account that owns no shop is reachable as `account`.
 */
export type HandleTarget =
  | {
      kind: 'shop';
      handle: string;
      /** Display name of the storefront. */
      name: string;
      shopId: string;
      /** The account behind the shop, for threads addressed to the person. */
      ownerId: string;
      /** Storefront colours, so a result row can look like the shop. */
      brand: string;
      brandSoft: string;
    }
  | {
      kind: 'account';
      handle: string;
      name: string;
      accountId: string;
    };

/**
 * Resolves "@name" to something messageable.
 *
 * Deliberately the only public way to find a person on the platform: an email
 * lookup would let anyone confirm whether an address has a Hoomri account and
 * harvest names off a list, whereas a handle is discoverable precisely because
 * its owner chose to publish one. Nothing here reveals an email or a phone
 * number, and a miss is indistinguishable from a name nobody has claimed.
 */
@Injectable()
export class HandleLookupService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  /** Strip a leading "@" and case, matching how handles are stored. */
  private normalize(raw: string): string {
    return raw.trim().toLowerCase().replace(/^@+/, '');
  }

  async resolve(raw: string): Promise<HandleTarget | null> {
    const handle = this.normalize(raw);
    if (!handle) return null;

    // Shops first: a seller's handle is their storefront's, so this is also
    // the answer for anyone who sells.
    const shop = await this.db.query.shops.findFirst({
      where: eq(shops.handle, handle),
      columns: {
        id: true,
        name: true,
        handle: true,
        ownerId: true,
        brand: true,
        brandSoft: true,
        live: true,
      },
    });
    if (shop) {
      // A shop that is switched off is not open to messages either.
      if (!shop.live) return null;
      return {
        kind: 'shop',
        handle: shop.handle,
        name: shop.name,
        shopId: shop.id,
        ownerId: shop.ownerId,
        brand: shop.brand,
        brandSoft: shop.brandSoft,
      };
    }

    const account = await this.db.query.users.findFirst({
      where: eq(users.handle, handle),
      columns: { id: true, name: true, handle: true },
    });
    if (!account?.handle) return null;
    return {
      kind: 'account',
      handle: account.handle,
      name: account.name,
      accountId: account.id,
    };
  }
}
