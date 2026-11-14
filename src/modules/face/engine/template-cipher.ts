import { createHmac } from 'node:crypto';

/**
 * Rotates face embeddings by a secret orthogonal matrix before they are
 * stored or searched.
 *
 * An orthogonal map preserves dot products, so cosine similarity between two
 * rotated templates equals the similarity between the originals: duplicate
 * search works unchanged. What it removes is portability - a template lifted
 * from the database cannot be matched against embeddings computed with a
 * stock SFace model, nor against another deployment's templates, without the
 * key. (A "cancelable biometric": rotate the key and every template must be
 * re-enrolled.)
 *
 * The matrix is derived deterministically from the key: HMAC-SHA256 in
 * counter mode → Gaussian entries (Box-Muller) → Gram-Schmidt.
 */
export class FaceTemplateCipher {
  private readonly rows: Float64Array[];

  constructor(
    keyHex: string,
    private readonly dims = 128,
  ) {
    const key = Buffer.from(keyHex, 'hex');
    if (key.length < 16) throw new Error('Face template key is too short');
    this.rows = orthonormalRows(gaussianMatrix(key, dims), dims);
  }

  apply(v: ArrayLike<number>): number[] {
    if (v.length !== this.dims) {
      throw new Error(`Expected a ${this.dims}-d embedding`);
    }
    const out = new Array<number>(this.dims);
    for (let i = 0; i < this.dims; i++) {
      const row = this.rows[i];
      let s = 0;
      for (let j = 0; j < this.dims; j++) s += row[j] * v[j];
      out[i] = s;
    }
    return out;
  }
}

/** Uniform doubles in (0,1) from HMAC-SHA256(key, counter). */
function* uniforms(key: Buffer): Generator<number> {
  for (let counter = 0; ; counter++) {
    const block = createHmac('sha256', key)
      .update(`hoomri-face-template:${counter}`)
      .digest();
    for (let i = 0; i + 4 <= block.length; i += 4) {
      // +1 / 2^32+2 keeps the value strictly inside (0,1) for Box-Muller's log.
      yield (block.readUInt32BE(i) + 1) / 4294967298;
    }
  }
}

function gaussianMatrix(key: Buffer, n: number): Float64Array[] {
  const u = uniforms(key);
  const next = () => u.next().value as number;
  const rows: Float64Array[] = [];
  for (let i = 0; i < n; i++) {
    const row = new Float64Array(n);
    for (let j = 0; j < n; j += 2) {
      const r = Math.sqrt(-2 * Math.log(next()));
      const t = 2 * Math.PI * next();
      row[j] = r * Math.cos(t);
      if (j + 1 < n) row[j + 1] = r * Math.sin(t);
    }
    rows.push(row);
  }
  return rows;
}

/** Modified Gram-Schmidt: a random Gaussian matrix → an orthonormal basis. */
function orthonormalRows(rows: Float64Array[], n: number): Float64Array[] {
  for (let i = 0; i < n; i++) {
    const v = rows[i];
    for (let k = 0; k < i; k++) {
      const q = rows[k];
      let d = 0;
      for (let j = 0; j < n; j++) d += v[j] * q[j];
      for (let j = 0; j < n; j++) v[j] -= d * q[j];
    }
    let norm = 0;
    for (let j = 0; j < n; j++) norm += v[j] * v[j];
    norm = Math.sqrt(norm);
    for (let j = 0; j < n; j++) v[j] /= norm;
  }
  return rows;
}
