import {
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { DbExecutor, DrizzleDB } from '../../database/drizzle.types';
import {
  faceChecks,
  faceSystem,
  faceTemplates,
  faceTemplateSamples,
  users,
} from '../../database/schema';
import { cosine } from './engine/sface';
import { FaceEngineService } from './engine/face-engine.service';
import { failedResult, FACE_MESSAGES, type FaceResult } from './face-errors';
import { FACE_POLICY_VERSION, faceCompatibility } from './face-version';

export interface Enrollment {
  sessionId: string;
  /** L2-normalised mean of the samples, already rotated by the cipher. */
  template: number[];
  /** 3-5 rotated frontal samples. */
  samples: number[][];
  liveness: number;
  consistency: number;
}

/** Arbitrary constant pair: every face enrollment takes this one lock. */
const ENROLL_LOCK = sql`SELECT pg_advisory_xact_lock(1752132978, 1)`;

/**
 * The decision: is this face new? Everything here runs in one transaction
 * behind one advisory lock, so two people (or one person on two accounts)
 * finishing at the same instant are judged one after the other and the
 * second sees the first.
 *
 * The search is exact - every stored mean and every stored sample against
 * the newcomer's mean and samples, highest similarity wins. That is
 * O(accounts), which is right for a uniqueness gate: an approximate index
 * would trade away exactly the recall this exists for.
 */
@Injectable()
export class FaceEnrollmentService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly config: ConfigService,
    private readonly engine: FaceEngineService,
  ) {}

  /**
   * Refuse if the stored faces were made with a different key or model than
   * this server is running: they could not be compared, and a uniqueness
   * check that cannot compare must not answer "new".
   */
  async assertCompatible(db: DbExecutor = this.db): Promise<void> {
    const key = this.config.get<string>('face.templateKey');
    const sha = this.engine.sfaceSha256;
    if (!key || !sha) {
      throw new ServiceUnavailableException({
        error: 'FaceUnavailable',
        message: 'The face check is not available right now. Try again later.',
      });
    }
    const mine = faceCompatibility(key, sha);
    await db
      .insert(faceSystem)
      .values({ id: 1, compatibility: mine })
      .onConflictDoNothing();
    const [bound] = await db
      .select()
      .from(faceSystem)
      .where(eq(faceSystem.id, 1));
    if (bound?.compatibility !== mine) {
      throw new ServiceUnavailableException({
        error: 'FaceUnavailable',
        message: 'The face check is not available right now. Try again later.',
      });
    }
  }

  /** Whether the bound key/model matches, without throwing. */
  async compatible(): Promise<boolean> {
    try {
      await this.assertCompatible();
      return true;
    } catch {
      return false;
    }
  }

  /** A near match waiting on an operator, whose other account still exists. */
  async onHold(userId: string, db: DbExecutor = this.db): Promise<boolean> {
    const [row] = await db
      .select({ id: faceChecks.id })
      .from(faceChecks)
      .where(
        and(
          eq(faceChecks.userId, userId),
          eq(faceChecks.reason, 'review'),
          isNull(faceChecks.reviewedAt),
          // The hold lapses by itself if the matched account is gone.
          sql`(${faceChecks.duplicateOfId} IS NULL OR EXISTS (SELECT 1 FROM users m WHERE m.id = ${faceChecks.duplicateOfId}))`,
        ),
      )
      .limit(1);
    return !!row;
  }

  /** The account may start (or finish) a check: not done, and not on hold. */
  async requirePending(
    userId: string,
    db: DbExecutor = this.db,
  ): Promise<void> {
    const [user] = await db
      .select({ faceVerifiedAt: users.faceVerifiedAt })
      .from(users)
      .where(eq(users.id, userId));
    if (!user) throw new BadRequestException('Account no longer exists');
    if (user.faceVerifiedAt) {
      throw new BadRequestException({
        error: 'FaceDone',
        message: 'Your face check is already done.',
      });
    }
    if (await this.onHold(userId, db)) {
      throw new BadRequestException({
        error: 'FaceReviewRequired',
        message: FACE_MESSAGES.review,
      });
    }
  }

  async enroll(userId: string, data: Enrollment): Promise<FaceResult> {
    for (const v of [data.template, ...data.samples]) {
      if (
        v.length !== 128 ||
        v.some((x) => !Number.isFinite(x)) ||
        Math.abs(Math.hypot(...v) - 1) > 0.01
      ) {
        throw new Error('Invalid face template');
      }
    }
    if (
      data.samples.length < 3 ||
      data.samples.length > 5 ||
      !Number.isFinite(data.liveness) ||
      !Number.isFinite(data.consistency)
    ) {
      throw new Error('Incomplete face enrollment');
    }
    const duplicateMin = this.config.getOrThrow<number>('face.duplicateMin');
    const reviewMin = this.config.getOrThrow<number>('face.reviewMin');

    return this.db.transaction(
      async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
        await tx.execute(sql`SET LOCAL statement_timeout = '15s'`);
        await tx.execute(ENROLL_LOCK);
        await this.assertCompatible(tx);
        await this.requirePending(userId, tx);

        // READ COMMITTED: read after the lock, so an enrollment that
        // committed while this one waited is in the gallery.
        const gallery = [
          ...(await tx
            .select({
              userId: faceTemplates.userId,
              embedding: faceTemplates.embedding,
            })
            .from(faceTemplates)
            .where(ne(faceTemplates.userId, userId))),
          ...(await tx
            .select({
              userId: faceTemplateSamples.userId,
              embedding: faceTemplateSamples.embedding,
            })
            .from(faceTemplateSamples)
            .where(ne(faceTemplateSamples.userId, userId))),
        ];
        const probes = [data.template, ...data.samples];
        let nearest: { userId: string; score: number } | null = null;
        for (const entry of gallery) {
          if (entry.embedding.length !== 128) continue;
          for (const probe of probes) {
            const score = cosine(probe, entry.embedding);
            if (!Number.isFinite(score)) {
              throw new Error('Invalid face match score');
            }
            if (!nearest || score > nearest.score) {
              nearest = { userId: entry.userId, score };
            }
          }
        }
        const reason =
          nearest && nearest.score >= duplicateMin
            ? 'duplicate'
            : nearest && nearest.score >= reviewMin
              ? 'review'
              : null;
        const verifiedAt = new Date();
        await tx.insert(faceChecks).values({
          userId,
          sessionId: data.sessionId,
          policyVersion: FACE_POLICY_VERSION,
          passed: !reason,
          reason: reason ?? 'capture_v2',
          liveness: data.liveness,
          consistency: data.consistency,
          duplicateOfId: nearest?.userId ?? null,
          duplicateScore: nearest?.score ?? null,
          flagged: !!reason,
        });
        if (reason) return failedResult(reason);

        await tx
          .insert(faceTemplates)
          .values({ userId, embedding: data.template })
          .onConflictDoUpdate({
            target: faceTemplates.userId,
            set: { embedding: data.template, createdAt: verifiedAt },
          });
        await tx
          .delete(faceTemplateSamples)
          .where(eq(faceTemplateSamples.userId, userId));
        await tx.insert(faceTemplateSamples).values(
          data.samples.map((embedding, slot) => ({
            userId,
            slot,
            embedding,
          })),
        );
        await tx
          .update(users)
          .set({ faceVerifiedAt: verifiedAt })
          .where(eq(users.id, userId));
        return { status: 'verified', verifiedAt: verifiedAt.toISOString() };
      },
      { isolationLevel: 'read committed' },
    );
  }
}
