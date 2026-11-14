import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, desc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDB } from '../../database/drizzle.types';
import { faceChecks, users } from '../../database/schema';
import {
  CAPTURE,
  STEP_DONE,
  STRIKE_FEEDBACK,
  advanceCapture,
  captureDone,
  keepSample,
  newCapture,
  observePose,
  poseFeedback,
  publicCapture,
  resetDwell,
  strike,
  timingFailure,
  type CaptureSession,
  type FaceFeedback,
  type FaceSession,
} from './capture-policy';
import { FaceEngineService } from './engine/face-engine.service';
import { FrameAnalysisService } from './engine/frame-analysis.service';
import { cosine, l2normalize } from './engine/sface';
import { FaceTemplateCipher } from './engine/template-cipher';
import { FaceEnrollmentService } from './face-enrollment.service';
import {
  FACE_MESSAGES,
  FaceCheckFailed,
  SOFT_FAILURES,
  failedResult,
  type FaceFailure,
  type FaceResult,
} from './face-errors';
import { FACE_POLICY_VERSION } from './face-version';

export type { FaceResult } from './face-errors';
export type { FaceSession } from './capture-policy';

/** Check attempts one account may start per hour. */
const ATTEMPTS_PER_HOUR = 8;
const HOUR_MS = 60 * 60 * 1000;

export interface FaceStatus {
  /** The models are loaded and the stored faces are comparable. */
  available: boolean;
  verified: boolean;
  verifiedAt: string | null;
  /** A near match is waiting on a person at Hoomri; no new attempt yet. */
  onHold: boolean;
  devBypass: boolean;
}

/**
 * The live camera check: the server sets each prompt, measures every frame
 * itself and decides when a step has been held. The browser only supplies
 * pixels - no pose or liveness claim from the client is ever accepted. It is
 * still not camera attestation: a capable virtual camera can synthesise
 * responsive imagery. It raises the cost of a second account; it does not
 * prove who somebody is.
 *
 * Session state lives in this process's memory. That is an invariant, not an
 * accident: the API runs as a single instance, a session lasts three minutes,
 * and losing one to a restart costs the person a retry. Running several API
 * instances would need this moved to a shared store first.
 */
@Injectable()
export class FaceService {
  private readonly logger = new Logger(FaceService.name);
  private cipher: FaceTemplateCipher | null = null;
  /** One live session per account; a new attempt replaces the old one. */
  private readonly sessions = new Map<string, CaptureSession>();
  /** Accounts with a frame (or a start) in flight. */
  private readonly busy = new Set<string>();
  /** Start times inside the last hour, per account. */
  private readonly attempts = new Map<string, number[]>();

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly engine: FaceEngineService,
    private readonly config: ConfigService,
    private readonly analysis: FrameAnalysisService,
    private readonly enrollment: FaceEnrollmentService,
  ) {
    const key = config.get<string>('face.templateKey');
    if (key) {
      this.cipher = new FaceTemplateCipher(key);
    } else {
      this.logger.warn(
        'FACE_TEMPLATE_KEY is not set - the face check is unavailable.',
      );
    }
  }

  get devBypassEnabled(): boolean {
    return this.config.get<boolean>('face.devBypass') === true;
  }

  async status(userId: string): Promise<FaceStatus> {
    const [user] = await this.db
      .select({ faceVerifiedAt: users.faceVerifiedAt })
      .from(users)
      .where(eq(users.id, userId));
    const available =
      this.engine.ready &&
      !!this.cipher &&
      (await this.enrollment.compatible());
    return {
      available,
      verified: !!user?.faceVerifiedAt,
      verifiedAt: user?.faceVerifiedAt?.toISOString() ?? null,
      onHold: user?.faceVerifiedAt
        ? false
        : await this.enrollment.onHold(userId),
      devBypass: this.devBypassEnabled,
    };
  }

  /** One request at a time per account; a second is told to wait. */
  private async locked<T>(userId: string, run: () => Promise<T>): Promise<T> {
    if (this.busy.has(userId)) {
      throw new ConflictException(
        'A face frame is already being processed. Please wait a moment.',
      );
    }
    this.busy.add(userId);
    try {
      return await run();
    } finally {
      this.busy.delete(userId);
    }
  }

  private live(userId: string): CaptureSession | null {
    const s = this.sessions.get(userId);
    if (!s) return null;
    if (Date.now() - s.issuedAt > CAPTURE.ttlMs) {
      this.sessions.delete(userId);
      return null;
    }
    return s;
  }

  private countAttempt(userId: string): void {
    const now = Date.now();
    const recent = (this.attempts.get(userId) ?? []).filter(
      (at) => now - at < HOUR_MS,
    );
    if (recent.length >= ATTEMPTS_PER_HOUR) {
      throw new HttpException(
        {
          error: 'FaceAttempts',
          message: 'Too many tries. Wait an hour and try again.',
          retryAfterSeconds: Math.ceil((recent[0] + HOUR_MS - now) / 1000),
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    recent.push(now);
    this.attempts.set(userId, recent);
    // Keep the map from growing without bound.
    if (this.attempts.size > 5_000) {
      for (const [id, times] of this.attempts) {
        if (times.every((at) => now - at >= HOUR_MS)) this.attempts.delete(id);
      }
    }
  }

  async startSession(userId: string): Promise<FaceSession> {
    return this.locked(userId, async () => {
      void this.engine.engines; // 503 if the models are not loaded
      if (!this.cipher) {
        throw new ServiceUnavailableException({
          error: 'FaceUnavailable',
          message:
            'The face check is not available right now. Try again later.',
        });
      }
      await this.enrollment.assertCompatible();
      await this.enrollment.requirePending(userId);
      this.countAttempt(userId);
      // A new attempt supersedes the previous one, including another tab.
      const s = newCapture(userId, Date.now());
      this.sessions.set(userId, s);
      return publicCapture(s, Date.now());
    });
  }

  /** How a finished session ended - for a client whose last reply was lost. */
  private async terminal(
    userId: string,
    sessionId?: string,
  ): Promise<FaceResult> {
    if (!sessionId) return failedResult('expired');
    const check = await this.db.query.faceChecks.findFirst({
      where: and(
        eq(faceChecks.userId, userId),
        eq(faceChecks.sessionId, sessionId),
      ),
      orderBy: desc(faceChecks.createdAt),
    });
    if (!check) return failedResult('expired');
    return check.passed
      ? { status: 'verified', verifiedAt: check.createdAt.toISOString() }
      : failedResult((check.reason as FaceFailure) ?? 'expired');
  }

  /**
   * The live session as it stands, for a client whose last frame response was
   * lost on the network: the frame may or may not have advanced the nonce.
   * Read-only. Old frames stay useless - they are caught by the pixel hash
   * and the arrival-time limits, not by the nonce being secret.
   */
  async current(
    userId: string,
    sessionId?: string,
  ): Promise<FaceSession | FaceResult> {
    return this.locked(userId, async () => {
      const s = this.live(userId);
      if (!s) return this.terminal(userId, sessionId);
      if (sessionId && s.sessionId !== sessionId)
        return failedResult('expired');
      return publicCapture(s, Date.now());
    });
  }

  async frame(
    userId: string,
    sessionId: string,
    nonce: string,
    buffer: Buffer,
  ): Promise<FaceSession | FaceResult> {
    const receivedAt = Date.now();
    return this.locked(userId, async () => {
      const cipher = this.cipher;
      const stored = this.live(userId);
      if (!cipher || !stored || stored.sessionId !== sessionId)
        return this.terminal(userId, sessionId);
      // An old packet cannot consume a newer challenge.
      if (stored.nonce !== nonce)
        throw new ConflictException(
          'The camera sequence changed. Please restart the check.',
        );
      // Work on a copy: a frame the analyser turns away for being busy (429)
      // must leave the session - nonce included - exactly as it was.
      const s = structuredClone(stored);
      const end = () => {
        if (this.sessions.get(userId) === stored) this.sessions.delete(userId);
      };
      const fail = async (reason: FaceFailure) => {
        end();
        await this.db.insert(faceChecks).values({
          userId,
          sessionId: s.sessionId,
          policyVersion: FACE_POLICY_VERSION,
          passed: false,
          reason,
          liveness: s.baseline || reason === 'spoof' ? s.liveness : null,
          consistency: s.baseline ? s.consistency : null,
        });
        return failedResult(reason);
      };
      const keep = (feedback?: FaceFeedback) => {
        this.sessions.set(userId, s);
        return publicCapture(s, Date.now(), feedback);
      };
      if (timingFailure(s, receivedAt)) return fail('expired');
      s.lastAt = receivedAt;
      s.frames++;
      s.nonce = randomUUID();
      try {
        const sample = await this.analysis.analyse(buffer);
        if (s.hashes.includes(sample.hash)) throw new FaceCheckFailed('replay');
        s.hashes.push(sample.hash);
        // Rotated vectors only, even in memory.
        const embedding = cipher.apply(sample.embedding);
        if (s.baseline) {
          const similarity = cosine(s.baseline, embedding);
          const minimum = sample.frontal
            ? this.config.getOrThrow<number>('face.consistencyMin')
            : 0.25;
          // The audit keeps the lowest score seen, a struck frame's too.
          if (sample.frontal && Number.isFinite(similarity))
            s.consistency = Math.min(s.consistency, similarity);
          if (!Number.isFinite(similarity) || similarity < minimum)
            throw new FaceCheckFailed('mismatch');
        }
        if (sample.frontal) {
          if (sample.liveness !== null && Number.isFinite(sample.liveness))
            s.liveness = Math.min(s.liveness, sample.liveness);
          if (
            sample.liveness === null ||
            !Number.isFinite(sample.liveness) ||
            sample.liveness < this.config.getOrThrow<number>('face.livenessMin')
          )
            throw new FaceCheckFailed('spoof');
          // Anchor identity at the first acceptable frame, not only at the
          // end of the initial dwell; otherwise an early face swap is missed.
          s.baseline ??= embedding;
          s.baselineYaw ??= sample.yaw;
        }
        // Live and the same face: a run of bad frames is broken.
        s.strikeRun = 0;
        let feedback: FaceFeedback;
        const advanced = observePose(s, sample.yaw, receivedAt);
        keepSample(s, embedding);
        if (advanced) {
          advanceCapture(s, Date.now());
          feedback = STEP_DONE;
        } else {
          feedback = poseFeedback(s, sample.yaw);
        }
        if (captureDone(s)) {
          // Consume BEFORE the database work: no session enrolls twice.
          end();
          const mean = new Float32Array(128);
          for (const v of s.samples)
            for (let i = 0; i < 128; i++) mean[i] += v[i] / s.samples.length;
          return await this.enrollment.enroll(userId, {
            sessionId: s.sessionId,
            template: Array.from(l2normalize(mean)),
            samples: s.samples,
            liveness: s.liveness,
            consistency: s.consistency,
          });
        }
        return keep(feedback);
      } catch (err) {
        // Capacity: nothing was judged, so nothing changes. The client waits
        // and sends its next frame against the same nonce.
        if (err instanceof HttpException && err.getStatus() === 429) throw err;
        if (err instanceof FaceCheckFailed) {
          if (SOFT_FAILURES.has(err.reason)) {
            resetDwell(s);
            return keep({
              code: err.reason,
              tone:
                err.reason === 'no_face' || err.reason === 'multiple_faces'
                  ? 'bad'
                  : 'warn',
              message: FACE_MESSAGES[err.reason],
            });
          }
          if (
            (err.reason === 'spoof' || err.reason === 'mismatch') &&
            strike(s)
          ) {
            resetDwell(s);
            return keep(STRIKE_FEEDBACK[err.reason]);
          }
          return fail(err.reason);
        }
        // Inference/decode failures never fall through into verification.
        end();
        if (err instanceof HttpException) throw err;
        this.logger.error(`Face frame failed: ${String(err)}`);
        throw new ServiceUnavailableException(
          'The camera check could not be processed. Please start again.',
        );
      }
    });
  }

  /** Development only (never in production): mark the account verified. */
  async devBypass(userId: string): Promise<FaceResult> {
    if (!this.devBypassEnabled) throw new ForbiddenException('Not available');
    await this.enrollment.requirePending(userId);
    const verifiedAt = new Date();
    await this.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ faceVerifiedAt: verifiedAt })
        .where(eq(users.id, userId));
      await tx.insert(faceChecks).values({
        userId,
        passed: true,
        reason: 'dev_bypass',
        policyVersion: FACE_POLICY_VERSION,
      });
    });
    return { status: 'verified', verifiedAt: verifiedAt.toISOString() };
  }
}
