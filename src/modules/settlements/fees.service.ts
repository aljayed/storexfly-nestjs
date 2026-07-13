import { Inject, Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import { platformSettings } from '../../database/schema';
import { CARD_FEE_BP, MBANK_FEE_BP } from './settlement.constants';

/** Fee rates in basis points, as currently configured by the platform. */
export interface FeeRates {
  mbankBp: number;
  cardBp: number;
}

/**
 * Reads and updates the platform-wide gateway fee rates, stored on the
 * {@link platformSettings} singleton. Everything that quotes or charges a fee
 * (item-form copy, pending settlement math) pulls rates through here on every
 * request, so a change from the platform console is visible immediately —
 * only paid settlement snapshots keep the rates they were recorded with.
 */
@Injectable()
export class FeesService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async getRates(): Promise<FeeRates> {
    const [row] = await this.db
      .select({
        mbankBp: platformSettings.mbankFeeBp,
        cardBp: platformSettings.cardFeeBp,
      })
      .from(platformSettings)
      .orderBy(asc(platformSettings.id))
      .limit(1);
    // Before the singleton row is seeded (fresh boot), quote the defaults.
    return row ?? { mbankBp: MBANK_FEE_BP, cardBp: CARD_FEE_BP };
  }

  /** Percents for API responses: { mbank: 3, card: 4.5 }. */
  async getPercents(): Promise<{ mbank: number; card: number }> {
    const rates = await this.getRates();
    return { mbank: rates.mbankBp / 100, card: rates.cardBp / 100 };
  }

  async updatePercents(
    mbank: number,
    card: number,
  ): Promise<{ mbank: number; card: number }> {
    const mbankBp = Math.round(mbank * 100);
    const cardBp = Math.round(card * 100);
    const [existing] = await this.db
      .select({ id: platformSettings.id })
      .from(platformSettings)
      .orderBy(asc(platformSettings.id))
      .limit(1);
    if (existing) {
      await this.db
        .update(platformSettings)
        .set({ mbankFeeBp: mbankBp, cardFeeBp: cardBp })
        .where(eq(platformSettings.id, existing.id));
    } else {
      await this.db
        .insert(platformSettings)
        .values({ mbankFeeBp: mbankBp, cardFeeBp: cardBp });
    }
    return { mbank: mbankBp / 100, card: cardBp / 100 };
  }
}
