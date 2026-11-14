import type { DrizzleDB } from '../../database/drizzle.types';
import { FaceEnrollmentService } from './face-enrollment.service';
import { faceCompatibility } from './face-version';

const KEY = 'ab'.repeat(32);
const SHA = 'c'.repeat(64);

/** A unit vector along one axis, optionally leaning towards another. */
function unit(axis: number, lean = 0, towards = 0): number[] {
  const v = new Array<number>(128).fill(0);
  v[axis] = Math.cos(lean);
  if (lean) v[towards] = Math.sin(lean);
  return v;
}

/**
 * The transaction is driven through select/insert/update/delete chains; the
 * fake answers each select in the order the service makes them and records
 * what was written.
 */
function harness(options: {
  gallery?: { userId: string; embedding: number[] }[];
  faceVerifiedAt?: Date | null;
  bound?: string;
}) {
  const written: { table: string; values: unknown }[] = [];
  const updated: unknown[] = [];
  const answers: unknown[][] = [
    // assertCompatible: the bound fingerprint
    [{ id: 1, compatibility: options.bound ?? faceCompatibility(KEY, SHA) }],
    // requirePending: the account, then any hold
    [{ faceVerifiedAt: options.faceVerifiedAt ?? null }],
    [],
    // the gallery: means, then samples
    options.gallery ?? [],
    [],
  ];
  const chain = (rows: unknown[]) => {
    const p = Promise.resolve(rows) as Promise<unknown[]> &
      Record<string, unknown>;
    p.where = () => chain(rows);
    p.limit = () => chain(rows);
    return p;
  };
  const tx = {
    execute: jest.fn().mockResolvedValue([]),
    select: jest.fn(() => ({ from: () => chain(answers.shift() ?? []) })),
    insert: jest.fn((table: { [k: symbol]: unknown }) => ({
      values: (values: unknown) => {
        const name = String(
          Object.getOwnPropertySymbols(table)
            .map((s) => table[s])
            .find((v) => typeof v === 'string' && v.startsWith('face_')),
        );
        written.push({ table: name, values });
        const done = Promise.resolve() as Promise<void> &
          Record<string, unknown>;
        done.onConflictDoNothing = () => Promise.resolve();
        done.onConflictDoUpdate = () => Promise.resolve();
        return done;
      },
    })),
    update: jest.fn(() => ({
      set: (values: unknown) => {
        updated.push(values);
        return { where: () => Promise.resolve() };
      },
    })),
    delete: jest.fn(() => ({ where: () => Promise.resolve() })),
  };
  const db = { transaction: jest.fn((fn: (t: unknown) => unknown) => fn(tx)) };
  const config = {
    get: (k: string) => (k === 'face.templateKey' ? KEY : undefined),
    getOrThrow: (k: string) =>
      ({ 'face.duplicateMin': 0.55, 'face.reviewMin': 0.45 })[k],
  };
  const service = new FaceEnrollmentService(
    db as unknown as DrizzleDB,
    config as never,
    { sfaceSha256: SHA } as never,
  );
  const check = () =>
    written.find((w) => w.table === 'face_checks')?.values as Record<
      string,
      unknown
    >;
  return { service, written, updated, check };
}

const me = {
  sessionId: '00000000-0000-4000-8000-000000000001',
  template: unit(0),
  samples: [unit(0), unit(0), unit(0)],
  liveness: 0.9,
  consistency: 0.8,
};

describe('face enrollment decision', () => {
  it('registers a face nobody else has', async () => {
    const h = harness({ gallery: [{ userId: 'other', embedding: unit(5) }] });
    const result = await h.service.enroll('me', me);
    expect(result.status).toBe('verified');
    expect(h.check()).toMatchObject({ passed: true, flagged: false });
    expect(h.written.map((w) => w.table)).toEqual(
      expect.arrayContaining(['face_templates', 'face_template_samples']),
    );
    expect(h.updated[0]).toHaveProperty('faceVerifiedAt');
  });

  it('refuses a face already registered on another account', async () => {
    // cos(0.3 rad) = 0.955: the same person on a second account.
    const h = harness({
      gallery: [{ userId: 'other', embedding: unit(0, 0.3, 1) }],
    });
    const result = await h.service.enroll('me', me);
    expect(result).toMatchObject({ status: 'failed', reason: 'duplicate' });
    expect(h.check()).toMatchObject({
      passed: false,
      flagged: true,
      duplicateOfId: 'other',
    });
    // Nothing registered, and the account stays unverified.
    expect(
      h.written.map((w) => w.table).filter((t) => t !== 'face_system'),
    ).toEqual(['face_checks']);
    expect(h.updated).toHaveLength(0);
  });

  it('holds a near match for a person to look at', async () => {
    // cos(1.05 rad) = 0.4976: between the review and duplicate thresholds.
    const h = harness({
      gallery: [{ userId: 'other', embedding: unit(0, 1.05, 1) }],
    });
    const result = await h.service.enroll('me', me);
    expect(result).toMatchObject({ status: 'failed', reason: 'review' });
    expect(h.updated).toHaveLength(0);
  });

  it('is unavailable when the key or model no longer matches the stored faces', async () => {
    const h = harness({ bound: 'f'.repeat(64) });
    await expect(h.service.enroll('me', me)).rejects.toMatchObject({
      status: 503,
    });
    expect(h.written.filter((w) => w.table !== 'face_system')).toHaveLength(0);
  });

  it('refuses an account that is already verified', async () => {
    const h = harness({ faceVerifiedAt: new Date() });
    await expect(h.service.enroll('me', me)).rejects.toMatchObject({
      response: { error: 'FaceDone' },
    });
  });

  it('rejects a malformed template outright', async () => {
    const h = harness({});
    await expect(
      h.service.enroll('me', {
        ...me,
        template: new Array<number>(128).fill(0),
      }),
    ).rejects.toThrow('Invalid face template');
  });
});
