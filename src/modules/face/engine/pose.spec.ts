import { isFrontal, turnedTowards, yawRatio } from './pose';
import type { DetectedFace } from './yunet';

const face = (noseX: number): DetectedFace => ({
  box: { x: 0, y: 0, w: 100, h: 120 },
  landmarks: [
    [30, 40],
    [70, 40],
    [noseX, 60],
    [35, 85],
    [65, 85],
  ],
  score: 0.9,
});

describe('pose', () => {
  it('does not mistake in-plane head roll for a left or right turn', () => {
    for (const angle of [-25, -10, 10, 25]) {
      const f = face(50),
        r = (angle * Math.PI) / 180;
      f.landmarks = f.landmarks.map(([x, y]) => [
        x * Math.cos(r) - y * Math.sin(r),
        x * Math.sin(r) + y * Math.cos(r),
      ]) as DetectedFace['landmarks'];
      expect(yawRatio(f)).toBeCloseTo(0.5);
      expect(turnedTowards('left', 0.5, yawRatio(f))).toBe(false);
      expect(turnedTowards('right', 0.5, yawRatio(f))).toBe(false);
    }
  });
  it('rejects degenerate eye geometry', () => {
    const f = face(50);
    f.landmarks[1] = f.landmarks[0];
    expect(Number.isNaN(yawRatio(f))).toBe(true);
  });
  it('reads a centred nose as frontal', () => {
    expect(yawRatio(face(50))).toBeCloseTo(0.5);
    expect(isFrontal(yawRatio(face(52)))).toBe(true);
  });

  it('reads a nose toward the image right as a turn to the left', () => {
    const r = yawRatio(face(58));
    expect(turnedTowards('left', 0.5, r)).toBe(true);
    expect(turnedTowards('right', 0.5, r)).toBe(false);
  });

  it('needs the turn to be far enough', () => {
    expect(turnedTowards('right', 0.5, yawRatio(face(48)))).toBe(false);
    expect(turnedTowards('right', 0.5, yawRatio(face(44)))).toBe(true);
  });
});
