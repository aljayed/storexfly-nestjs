import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import {
  faceChecks,
  faceTemplates,
  faceTemplateSamples,
  shops,
  users,
} from '../../database/schema';

export interface FaceCheckView {
  id: string;
  createdAt: string;
  reason: string | null;
  passed: boolean;
  score: number | null;
  liveness: number | null;
  open: boolean;
  reviewedAt: string | null;
  reviewNote: string | null;
  account: FaceAccountView;
  /** The account the face resembled, if it still exists. */
  matched: FaceAccountView | null;
}

interface FaceAccountView {
  id: string;
  publicId: string;
  name: string;
  email: string | null;
  phone: string | null;
  shops: string[];
}

/**
 * What the operator can do about a face check. There is no "approve" here on
 * purpose: no photo is kept, so nobody at a console can see whether two
 * accounts are one person, and a similarity score cannot settle it. The two
 * actions are the two things an operator can actually know from talking to
 * the people involved:
 *
 *  - `release` - let a held account try the camera again (it is judged
 *    afresh, and held again if it still matches);
 *  - `resetFace` - forget an account's registered face, freeing that face
 *    for whichever account its owner really wants to use.
 */
@Injectable()
export class FaceReviewService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  /** Duplicates and near matches, newest first. */
  async flagged(): Promise<FaceCheckView[]> {
    const rows = await this.db
      .select()
      .from(faceChecks)
      .where(eq(faceChecks.flagged, true))
      .orderBy(desc(faceChecks.createdAt))
      .limit(200);
    const ids = [
      ...new Set(
        rows.flatMap((r) => [r.userId, r.duplicateOfId]).filter(Boolean),
      ),
    ] as string[];
    const accounts = new Map<string, FaceAccountView>();
    if (ids.length) {
      const people = await this.db
        .select({
          id: users.id,
          publicId: users.publicId,
          name: users.name,
          email: users.email,
          phone: users.phone,
        })
        .from(users)
        .where(inArray(users.id, ids));
      const owned = await this.db
        .select({ ownerId: shops.ownerId, handle: shops.handle })
        .from(shops)
        .where(inArray(shops.ownerId, ids));
      for (const p of people) {
        accounts.set(p.id, {
          ...p,
          shops: owned.filter((s) => s.ownerId === p.id).map((s) => s.handle),
        });
      }
    }
    return rows.flatMap((r) => {
      const account = accounts.get(r.userId);
      if (!account) return [];
      return [
        {
          id: r.id,
          createdAt: r.createdAt.toISOString(),
          reason: r.reason,
          passed: r.passed,
          score: r.duplicateScore,
          liveness: r.liveness,
          open: r.reason === 'review' && !r.reviewedAt,
          reviewedAt: r.reviewedAt?.toISOString() ?? null,
          reviewNote: r.reviewNote,
          account,
          matched: r.duplicateOfId
            ? (accounts.get(r.duplicateOfId) ?? null)
            : null,
        },
      ];
    });
  }

  /** Lift a hold so the account may run the check again. */
  async release(id: string, actor: string, note: string): Promise<void> {
    const [row] = await this.db
      .update(faceChecks)
      .set({ reviewedAt: new Date(), reviewedBy: actor, reviewNote: note })
      .where(and(eq(faceChecks.id, id), isNull(faceChecks.reviewedAt)))
      .returning({ id: faceChecks.id });
    if (!row) throw new NotFoundException('No open face check with that id.');
  }

  /**
   * Forget an account's face. Refused while the account owns a shop: the
   * face is what that shop was opened on, and freeing it would let the same
   * person open a second one.
   */
  async resetFace(userId: string, actor: string, note: string): Promise<void> {
    const owned = await this.db
      .select({ id: shops.id })
      .from(shops)
      .where(eq(shops.ownerId, userId))
      .limit(1);
    if (owned.length) {
      throw new BadRequestException(
        'This account owns a shop. Its face stays registered while the shop exists.',
      );
    }
    await this.db.transaction(async (tx) => {
      await tx
        .delete(faceTemplateSamples)
        .where(eq(faceTemplateSamples.userId, userId));
      await tx.delete(faceTemplates).where(eq(faceTemplates.userId, userId));
      await tx
        .update(users)
        .set({ faceVerifiedAt: null })
        .where(eq(users.id, userId));
      await tx.insert(faceChecks).values({
        userId,
        passed: false,
        reason: 'reset',
        reviewedAt: new Date(),
        reviewedBy: actor,
        reviewNote: note,
      });
    });
  }
}
