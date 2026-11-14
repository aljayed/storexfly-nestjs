import { createHmac } from 'node:crypto';

/** Capture rules and thresholds in force, recorded on every audit row. */
export const FACE_POLICY_VERSION = 'capture4-hoomri1';

/**
 * A fingerprint of everything two stored faces must share to be comparable:
 * the template key, the recognition model and how its input is prepared.
 * Not reversible to the key.
 */
export function faceCompatibility(key: string, sfaceSha256: string): string {
  return createHmac('sha256', Buffer.from(key, 'hex'))
    .update('hoomri-face-compatibility-v1:')
    .update(sfaceSha256)
    .update(':rgb112-bilinear-v1:orthogonal-v1')
    .digest('hex');
}
