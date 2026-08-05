import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import { shops, type UserRow } from '../../database/schema';
import type { SessionScope } from '../../common/types/principal';

/**
 * Decides how much a freshly-minted account session may do.
 *
 * Buyer and seller share one `users` row, so the boundary is drawn at proof of
 * identity rather than at the table: an account that has verified neither its
 * email nor its phone can only ever have arrived through the "create my
 * account" tick at checkout, and gets a `storefront` session. Verifying either
 * contact detail - or already owning a shop, which covers accounts that predate
 * scopes - earns the full `account` session.
 *
 * The scope is recomputed on every mint, so proving a contact detail and
 * refreshing the session (POST /auth/session/refresh) is all an upgrade takes.
 */
@Injectable()
export class SessionScopeService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async resolve(user: UserRow): Promise<SessionScope> {
    if (user.emailVerified || user.phoneVerified) {
      return 'account';
    }
    const owned = await this.db.query.shops.findFirst({
      where: eq(shops.ownerId, user.id),
      columns: { id: true },
    });
    return owned ? 'account' : 'storefront';
  }
}
