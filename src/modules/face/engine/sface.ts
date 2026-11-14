import * as ort from 'onnxruntime-node';
import { RgbImage, toChwTensor, warpAffine } from './image';
import type { DetectedFace, Point } from './yunet';

/** Reference landmark positions for a 112×112 aligned face (ArcFace / SFace convention). */
const REFERENCE: Point[] = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

/**
 * Least-squares similarity transform (rotation + uniform scale + translation)
 * mapping `src` points onto `dst` points.
 */
export function similarityTransform(
  src: Point[],
  dst: Point[],
): [number, number, number, number, number, number] {
  const n = src.length;
  let sx = 0,
    sy = 0,
    dx = 0,
    dy = 0;
  for (let i = 0; i < n; i++) {
    sx += src[i][0];
    sy += src[i][1];
    dx += dst[i][0];
    dy += dst[i][1];
  }
  sx /= n;
  sy /= n;
  dx /= n;
  dy /= n;
  let num1 = 0,
    num2 = 0,
    den = 0;
  for (let i = 0; i < n; i++) {
    const px = src[i][0] - sx,
      py = src[i][1] - sy;
    const qx = dst[i][0] - dx,
      qy = dst[i][1] - dy;
    num1 += px * qx + py * qy;
    num2 += px * qy - py * qx;
    den += px * px + py * py;
  }
  const a = num1 / den;
  const b = num2 / den;
  const tx = dx - (a * sx - b * sy);
  const ty = dy - (b * sx + a * sy);
  return [a, -b, tx, b, a, ty];
}

export function l2normalize(v: Float32Array): Float32Array {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  return v.map((x) => x / n);
}

/** Cosine similarity of two L2-normalised vectors. */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** SFace face recogniser (OpenCV Zoo, Apache-2.0). 112×112 aligned RGB → 128-d embedding. */
export class SFace {
  private constructor(private readonly session: ort.InferenceSession) {}

  static async load(path: string): Promise<SFace> {
    return new SFace(
      await ort.InferenceSession.create(path, {
        intraOpNumThreads: 2,
        interOpNumThreads: 1,
        // Errors only: the stock SFace graph logs ~100 harmless warnings.
        logSeverityLevel: 3,
      }),
    );
  }

  align(img: RgbImage, face: DetectedFace): RgbImage {
    return warpAffine(
      img,
      similarityTransform(face.landmarks, REFERENCE),
      112,
      112,
    );
  }

  async embed(img: RgbImage, face: DetectedFace): Promise<Float32Array> {
    return this.embedAligned(this.align(img, face));
  }

  async embedAligned(aligned: RgbImage): Promise<Float32Array> {
    const tensor = new ort.Tensor(
      'float32',
      toChwTensor(aligned),
      [1, 3, 112, 112],
    );
    const out = await this.session.run({ data: tensor });
    return l2normalize(new Float32Array(out.fc1.data as Float32Array));
  }
}
