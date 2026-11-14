import { randomInt, randomUUID } from 'node:crypto';
import { isFrontal, POSE, turnedTowards } from './engine/pose';

export type FaceChallenge = 'straight' | 'left' | 'right';
export const CAPTURE = {
  ttlMs: 180_000,
  stepMs: 25_000,
  maxGapMs: 8_000,
  minGapMs: 200,
  intervalMs: 350,
  maxFrames: 180,
  /** Straight, one turn (random side), the other turn, straight again. */
  totalSteps: 4,
  /** Frontal samples kept per straight step, and in all (enrollment takes 3-5). */
  samplesPerStep: 3,
  maxSamples: 5,
  /** Smaller than the turn threshold, so a held turn cannot pass neutral. */
  neutralYawTolerance: 0.06,
  /**
   * Frames that look unlive or unlike the first face. One bad frame (a
   * blink, motion blur, a light flicker) only restarts the hold; this many
   * in a row, or `maxStrikes` in all, fails the attempt. A photo, screen or
   * face swap fails every frame, so it is still caught within a second.
   */
  strikesInRow: 3,
  maxStrikes: 6,
};

/**
 * Only derived measurements are kept here between frames - no image.
 */
export interface CaptureSession {
  version: 4;
  userId: string;
  sessionId: string;
  nonce: string;
  issuedAt: number;
  stepAt: number;
  lastAt: number;
  frames: number;
  step: number;
  challenge: FaceChallenge;
  dwellMs: number;
  heldSince: number | null;
  heldFrames: number;
  baselineYaw: number | null;
  baseline: number[] | null;
  /** Protected frontal samples, from held frames of the straight steps. */
  samples: number[][];
  /** How many of those the current step has contributed. */
  stepSamples: number;
  hashes: string[];
  liveness: number;
  consistency: number;
  /** Unlive or mismatched frames: in a row, and in all (see CAPTURE). */
  strikeRun: number;
  strikes: number;
}

/**
 * What the last frame showed, said to the person while they are still in
 * front of the camera. `hold` means the pose is right and the step is
 * counting down; how long it needs stays on the server (the dwell is random).
 */
export interface FaceFeedback {
  code: string;
  tone: 'ok' | 'warn' | 'bad';
  message: string;
}

export interface FaceSession {
  status: 'capturing';
  sessionId: string;
  nonce: string;
  challenge: FaceChallenge;
  step: number;
  totalSteps: number;
  intervalMs: number;
  expiresAt: string;
  /** Time left for the current step, after which the attempt expires. */
  stepRemainingMs: number;
  feedback?: FaceFeedback;
}

export function newCapture(userId: string, now: number): CaptureSession {
  return {
    version: 4,
    userId,
    sessionId: randomUUID(),
    nonce: randomUUID(),
    issuedAt: now,
    stepAt: now,
    lastAt: 0,
    frames: 0,
    step: 0,
    challenge: 'straight',
    dwellMs: randomInt(650, 1051),
    heldSince: null,
    heldFrames: 0,
    baselineYaw: null,
    baseline: null,
    samples: [],
    stepSamples: 0,
    hashes: [],
    liveness: 1,
    consistency: 1,
    strikeRun: 0,
    strikes: 0,
  };
}

export function publicCapture(
  s: CaptureSession,
  now: number,
  feedback?: FaceFeedback,
): FaceSession {
  const deadline = Math.min(
    s.stepAt + CAPTURE.stepMs,
    s.issuedAt + CAPTURE.ttlMs,
  );
  return {
    status: 'capturing',
    sessionId: s.sessionId,
    nonce: s.nonce,
    challenge: s.challenge,
    step: s.step,
    totalSteps: CAPTURE.totalSteps,
    intervalMs: CAPTURE.intervalMs,
    expiresAt: new Date(s.issuedAt + CAPTURE.ttlMs).toISOString(),
    stepRemainingMs: Math.max(0, deadline - now),
    feedback,
  };
}

export const STEP_DONE: FaceFeedback = {
  code: 'step_done',
  tone: 'ok',
  message: 'Got it.',
};

/**
 * Feedback on a frame whose face was usable, after {@link observePose} has
 * judged it. Speaks only of the current prompt, never the next one.
 */
export function poseFeedback(s: CaptureSession, yaw: number): FaceFeedback {
  if (s.heldSince !== null)
    return {
      code: 'hold',
      tone: 'ok',
      message:
        s.challenge === 'straight' ? 'Hold still…' : 'Good. Hold it there…',
    };
  if (s.challenge === 'straight')
    return {
      code: 'look_straight',
      tone: 'warn',
      message: 'Face the camera straight on.',
    };
  const side = s.challenge;
  // Positive when moving the requested way (see turnedTowards).
  const towards =
    s.baselineYaw === null || !Number.isFinite(yaw)
      ? 0
      : (yaw - s.baselineYaw) * (side === 'left' ? 1 : -1);
  if (towards < -POSE.turnMin / 2)
    return {
      code: 'wrong_way',
      tone: 'bad',
      message: `Other way. Turn to your ${side}.`,
    };
  return {
    code: 'turn_more',
    tone: 'warn',
    message: `Turn a little more to your ${side}.`,
  };
}

export function timingFailure(s: CaptureSession, receivedAt: number): boolean {
  return (
    receivedAt < s.issuedAt ||
    receivedAt - s.issuedAt > CAPTURE.ttlMs ||
    receivedAt - s.stepAt > CAPTURE.stepMs ||
    s.frames >= CAPTURE.maxFrames ||
    (!!s.lastAt &&
      (receivedAt - s.lastAt < CAPTURE.minGapMs ||
        receivedAt - s.lastAt > CAPTURE.maxGapMs))
  );
}

export function resetDwell(s: CaptureSession): void {
  s.heldSince = null;
  s.heldFrames = 0;
  // Discard only this interrupted step's samples, retaining completed steps.
  if (s.stepSamples) s.samples.splice(s.samples.length - s.stepSamples);
  s.stepSamples = 0;
}

/** Server measurements and arrival times only. The client cannot advance a step. */
export function observePose(
  s: CaptureSession,
  yaw: number,
  receivedAt: number,
): boolean {
  const matches =
    s.challenge === 'straight'
      ? isFrontal(yaw) &&
        (s.baselineYaw === null ||
          Math.abs(yaw - s.baselineYaw) <= CAPTURE.neutralYawTolerance)
      : s.baselineYaw !== null &&
        turnedTowards(s.challenge, s.baselineYaw, yaw);
  if (!matches) {
    resetDwell(s);
    return false;
  }
  s.heldSince ??= receivedAt;
  s.heldFrames++;
  return s.heldFrames >= 3 && receivedAt - s.heldSince >= s.dwellMs;
}

/**
 * Straight, then one turn - its side chosen only once the straight step has
 * passed - then the opposite turn, then straight again. Each turn is measured
 * from the first frontal frame, so reaching the second side means crossing
 * back through neutral; holding the first turn can never satisfy it.
 */
export function advanceCapture(s: CaptureSession, now: number): void {
  const previous = s.challenge;
  s.step++;
  s.challenge =
    s.step === 1
      ? randomInt(2) === 0
        ? 'left'
        : 'right'
      : s.step === 2
        ? previous === 'left'
          ? 'right'
          : 'left'
        : 'straight';
  s.stepAt = now;
  s.dwellMs = randomInt(650, 1051);
  s.stepSamples = 0;
  resetDwell(s);
}

/** Keep a held frontal frame of a straight step as an enrollment sample. */
export function keepSample(s: CaptureSession, embedding: number[]): void {
  if (s.challenge !== 'straight' || s.heldSince === null) return;
  if (s.samples.length >= CAPTURE.maxSamples) return;
  if (s.stepSamples >= CAPTURE.samplesPerStep) return;
  s.samples.push(embedding);
  s.stepSamples++;
}

export function captureDone(s: CaptureSession): boolean {
  return s.step === CAPTURE.totalSteps;
}

/**
 * A frame that looked unlive or unlike the first face. True while the
 * attempt can go on (the hold restarts); false once it must fail.
 */
export function strike(s: CaptureSession): boolean {
  s.strikeRun++;
  s.strikes++;
  return s.strikeRun < CAPTURE.strikesInRow && s.strikes < CAPTURE.maxStrikes;
}

export const STRIKE_FEEDBACK: Record<'spoof' | 'mismatch', FaceFeedback> = {
  spoof: {
    code: 'live_retry',
    tone: 'warn',
    message: 'Hold still in even light, with the camera pointed at your face.',
  },
  mismatch: {
    code: 'same_retry',
    tone: 'warn',
    message: 'Hold still and keep your whole face in the frame.',
  },
};
