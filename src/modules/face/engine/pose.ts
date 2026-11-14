import type { DetectedFace } from './yunet';

/**
 * Head yaw as a ratio: where the nose tip sits between the two eyes, on a
 * raw (non-mirrored) camera frame. 0.5 is facing the camera.
 *
 * For a head turned by θ the nose, ~20 mm proud of the eye plane, moves by
 * about 0.31·tan θ of the eye distance, so 0.5 ± 0.09 is roughly ±16°.
 * Turning to the person's own *left* moves the nose toward the image's right,
 * which raises the ratio. Only the server measures pose; the web client
 * displays the current prompt and submits unmirrored camera frames.
 */
export function yawRatio(face: DetectedFace): number {
  const [rightEye, leftEye, nose] = face.landmarks;
  // Project onto the eye line: in-plane roll must not count as a turn.
  const dx = leftEye[0] - rightEye[0];
  const dy = leftEye[1] - rightEye[1];
  const squared = dx * dx + dy * dy;
  if (!Number.isFinite(squared) || squared < 16) return NaN;
  return (
    ((nose[0] - rightEye[0]) * dx + (nose[1] - rightEye[1]) * dy) / squared
  );
}

export const POSE = {
  /** |ratio − 0.5| at most this for a frame that should face the camera. */
  frontalMax: 0.1,
  /** A turn must move the ratio at least this far from the frontal frame. */
  turnMin: 0.08,
};

export type TurnDirection = 'left' | 'right';

/** Did this frame turn the right way, far enough, from the frontal one? */
export function turnedTowards(
  direction: TurnDirection,
  frontal: number,
  turned: number,
): boolean {
  const delta = turned - frontal;
  return direction === 'left' ? delta >= POSE.turnMin : -delta >= POSE.turnMin;
}

export function isFrontal(ratio: number): boolean {
  return Math.abs(ratio - 0.5) <= POSE.frontalMax;
}
