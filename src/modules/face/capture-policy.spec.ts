import {
  CAPTURE,
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
} from './capture-policy';

describe('live capture boundaries', () => {
  it('lets a single bad frame restart the hold, but not a run of them', () => {
    const s = newCapture('user', 1000);
    expect(strike(s)).toBe(true);
    s.strikeRun = 0; // a good frame broke the run
    expect(strike(s)).toBe(true);
    expect(strike(s)).toBe(true);
    expect(strike(s)).toBe(false); // three in a row
  });
  it('fails an attempt with too many bad frames in all', () => {
    const s = newCapture('user', 1000);
    let alive = true;
    for (let i = 0; i < CAPTURE.maxStrikes && alive; i++) {
      alive = strike(s);
      s.strikeRun = 0;
    }
    expect(alive).toBe(false);
    expect(s.strikes).toBe(CAPTURE.maxStrikes);
  });
  it('discards interrupted dwell samples without discarding completed steps', () => {
    const s = newCapture('user', 1000);
    s.samples = [[1], [2], [3]];
    s.step = 3;
    s.stepSamples = 0;
    observePose(s, 0.5, 1500);
    keepSample(s, [4]);
    expect(s.samples).toHaveLength(4);
    resetDwell(s);
    expect(s.samples).toEqual([[1], [2], [3]]);
    expect(s.stepSamples).toBe(0);
  });
  it('does not count isolated correct poses across wrong poses as a completed challenge', () => {
    const s = newCapture('user', 1000);
    s.challenge = 'left';
    s.baselineYaw = 0.5;
    s.dwellMs = 650;
    expect(observePose(s, 0.7, 1500)).toBe(false);
    expect(observePose(s, 0.3, 1900)).toBe(false);
    expect(observePose(s, 0.7, 2300)).toBe(false);
    expect(observePose(s, 0.7, 2700)).toBe(false);
    expect(observePose(s, 0.7, 3100)).toBe(true);
  });

  it('requires at least three observations even after enough elapsed time', () => {
    const s = newCapture('user', 1000);
    expect(observePose(s, 0.5, 1500)).toBe(false);
    expect(observePose(s, 0.5, 3500)).toBe(false);
    expect(observePose(s, 0.5, 3900)).toBe(true);
    resetDwell(s);
    expect(observePose(s, 0.5, 4300)).toBe(false);
  });

  it('rejects non-finite poses and unanchored turns', () => {
    const s = newCapture('user', 1000);
    expect(observePose(s, NaN, 1500)).toBe(false);
    s.challenge = 'left';
    expect(observePose(s, 0.7, 1900)).toBe(false);
  });

  it('requires returning to the initial neutral pose between turns', () => {
    const s = newCapture('user', 1000);
    s.baselineYaw = 0.5;
    s.dwellMs = 650;
    s.challenge = 'left';
    expect(observePose(s, 0.59, 1500)).toBe(false);
    expect(observePose(s, 0.59, 1900)).toBe(false);
    expect(observePose(s, 0.59, 2300)).toBe(true);
    s.challenge = 'straight';
    resetDwell(s);
    // 0.59 is frontal to the recognition/PAD models, but remains a turn
    // relative to the starting pose. Holding it must not pass neutral.
    expect(observePose(s, 0.59, 2700)).toBe(false);
    expect(observePose(s, 0.59, 3100)).toBe(false);
    expect(observePose(s, 0.59, 3500)).toBe(false);
    expect(observePose(s, 0.51, 3900)).toBe(false);
    expect(observePose(s, 0.51, 4300)).toBe(false);
    expect(observePose(s, 0.51, 4700)).toBe(true);
  });

  it('enforces session, step, cadence and frame budgets independently', () => {
    const s = newCapture('user', 1000);
    expect(timingFailure(s, 999)).toBe(true);
    expect(timingFailure(s, 181001)).toBe(true);
    expect(timingFailure(s, 26001)).toBe(true);
    s.lastAt = 1500;
    expect(timingFailure(s, 1699)).toBe(true);
    expect(timingFailure(s, 9501)).toBe(true);
    expect(timingFailure(s, 1900)).toBe(false);
    s.frames = 180;
    expect(timingFailure(s, 1900)).toBe(true);
  });

  it('never exposes biometric measurements, hashes, dwell time or future prompts', () => {
    const s = newCapture('user', 1000);
    s.baseline = [123];
    s.hashes = ['private'];
    expect(Object.keys(publicCapture(s, 1000)).sort()).toEqual(
      [
        'challenge',
        'expiresAt',
        'feedback',
        'intervalMs',
        'nonce',
        'sessionId',
        'status',
        'step',
        'stepRemainingMs',
        'totalSteps',
      ].sort(),
    );
  });

  it('reports time left in the step, capped by the session', () => {
    const s = newCapture('user', 1000);
    expect(publicCapture(s, 6000).stepRemainingMs).toBe(20_000);
    s.stepAt = 170_000;
    expect(publicCapture(s, 175_000).stepRemainingMs).toBe(6_000);
    expect(publicCapture(s, 200_000).stepRemainingMs).toBe(0);
  });

  it('asks straight, one turn, the opposite turn, then straight - once each', () => {
    const seen = new Set<string>();
    for (let run = 0; run < 40; run++) {
      const s = newCapture('user', 1000);
      const order = [s.challenge];
      while (!captureDone(s)) {
        advanceCapture(s, 2000);
        if (!captureDone(s)) order.push(s.challenge);
      }
      expect(order).toHaveLength(CAPTURE.totalSteps);
      expect([order[0], order[3]]).toEqual(['straight', 'straight']);
      expect(new Set([order[1], order[2]])).toEqual(new Set(['left', 'right']));
      seen.add(order[1]);
    }
    // The first side is random, not fixed.
    expect(seen).toEqual(new Set(['left', 'right']));
  });

  it('keeps held straight frames as samples: 3 per step, 5 in all', () => {
    const s = newCapture('user', 1000);
    const v = [1];
    keepSample(s, v);
    expect(s.samples).toHaveLength(0); // not held yet
    for (let t = 1500; t < 3500; t += 400) {
      observePose(s, 0.5, t);
      keepSample(s, v);
    }
    expect(s.samples).toHaveLength(3);
    advanceCapture(s, 4000);
    s.heldSince = 4000;
    keepSample(s, v);
    expect(s.samples).toHaveLength(3); // a turn contributes nothing
    advanceCapture(s, 5000);
    advanceCapture(s, 6000);
    for (let t = 6400; t < 8000; t += 400) {
      observePose(s, 0.5, t);
      keepSample(s, v);
    }
    expect(s.samples).toHaveLength(5);
  });

  it('feedback names only the current prompt and the way to move', () => {
    const s = newCapture('user', 1000);
    expect(poseFeedback(s, 0.75).code).toBe('look_straight');
    s.challenge = 'left';
    s.baselineYaw = 0.5;
    expect(poseFeedback(s, 0.53).code).toBe('turn_more');
    expect(poseFeedback(s, 0.4)).toMatchObject({
      code: 'wrong_way',
      message: 'Other way. Turn to your left.',
    });
    expect(observePose(s, 0.62, 1500)).toBe(false);
    expect(poseFeedback(s, 0.62)).toMatchObject({ code: 'hold', tone: 'ok' });
    for (const yaw of [0.75, 0.53, 0.4, 0.62])
      expect(JSON.stringify(poseFeedback(s, yaw))).not.toMatch(/right/);
  });
});
