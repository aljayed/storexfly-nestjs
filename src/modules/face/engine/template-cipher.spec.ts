import { FaceTemplateCipher } from './template-cipher';

function randomUnit(n: number, seed: number): number[] {
  let x = seed;
  const v = Array.from({ length: n }, () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648 - 0.5;
  });
  const norm = Math.hypot(...v);
  return v.map((e) => e / norm);
}

const dot = (a: number[], b: number[]) =>
  a.reduce((s, e, i) => s + e * b[i], 0);

describe('FaceTemplateCipher', () => {
  const key = 'a'.repeat(64);
  const cipher = new FaceTemplateCipher(key);

  it('preserves cosine similarity between templates', () => {
    const a = randomUnit(128, 1);
    const b = randomUnit(128, 2);
    expect(dot(cipher.apply(a), cipher.apply(b))).toBeCloseTo(dot(a, b), 9);
  });

  it('keeps unit vectors unit length', () => {
    const r = cipher.apply(randomUnit(128, 3));
    expect(Math.hypot(...r)).toBeCloseTo(1, 9);
  });

  it('is deterministic for a key', () => {
    const v = randomUnit(128, 4);
    expect(new FaceTemplateCipher(key).apply(v)).toEqual(cipher.apply(v));
  });

  it('gives unrelated templates under a different key', () => {
    const v = randomUnit(128, 5);
    const other = new FaceTemplateCipher('b'.repeat(64));
    // Same face, two keys: no better than chance.
    expect(Math.abs(dot(cipher.apply(v), other.apply(v)))).toBeLessThan(0.4);
  });

  it('actually moves the vector', () => {
    const v = randomUnit(128, 6);
    expect(Math.abs(dot(cipher.apply(v), v))).toBeLessThan(0.4);
  });
});
