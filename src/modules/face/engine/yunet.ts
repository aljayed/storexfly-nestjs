import * as ort from 'onnxruntime-node';
import { RgbImage, resizeImage, toChwTensor } from './image';

export type Point = [number, number];

export interface DetectedFace {
  /** Box in source-image pixels. */
  box: { x: number; y: number; w: number; h: number };
  /**
   * 5 landmarks in source-image pixels, YuNet order:
   * right eye, left eye, nose tip, right mouth corner, left mouth corner
   * ("right" = the person's right, which is the image's left on a non-mirrored frame).
   */
  landmarks: [Point, Point, Point, Point, Point];
  score: number;
}

const INPUT = 640;
const STRIDES = [8, 16, 32];

/** YuNet face detector (OpenCV Zoo, MIT). Fixed 640×640 input, BGR, 0–255. */
export class YuNet {
  private constructor(private readonly session: ort.InferenceSession) {}

  static async load(path: string): Promise<YuNet> {
    return new YuNet(
      await ort.InferenceSession.create(path, {
        intraOpNumThreads: 2,
        interOpNumThreads: 1,
        // Errors only: the stock SFace graph logs ~100 harmless warnings.
        logSeverityLevel: 3,
      }),
    );
  }

  async detect(
    img: RgbImage,
    scoreThreshold = 0.7,
    nmsThreshold = 0.3,
  ): Promise<DetectedFace[]> {
    // Letterbox: fit inside 640×640 keeping aspect, pad right/bottom with black.
    const scale = Math.min(INPUT / img.width, INPUT / img.height);
    const rw = Math.max(1, Math.round(img.width * scale));
    const rh = Math.max(1, Math.round(img.height * scale));
    const resized = await resizeImage(img, rw, rh);
    const padded = new Uint8Array(INPUT * INPUT * 3);
    for (let y = 0; y < rh; y++) {
      padded.set(
        resized.data.subarray(y * rw * 3, (y + 1) * rw * 3),
        y * INPUT * 3,
      );
    }
    const tensor = new ort.Tensor(
      'float32',
      toChwTensor({ data: padded, width: INPUT, height: INPUT }, { bgr: true }),
      [1, 3, INPUT, INPUT],
    );
    const out = await this.session.run({ input: tensor });

    const faces: DetectedFace[] = [];
    for (const stride of STRIDES) {
      const cls = out[`cls_${stride}`].data as Float32Array;
      const obj = out[`obj_${stride}`].data as Float32Array;
      const bbox = out[`bbox_${stride}`].data as Float32Array;
      const kps = out[`kps_${stride}`].data as Float32Array;
      const cols = INPUT / stride;
      const rows = INPUT / stride;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const idx = r * cols + c;
          const clsScore = Math.min(1, Math.max(0, cls[idx]));
          const objScore = Math.min(1, Math.max(0, obj[idx]));
          const score = Math.sqrt(clsScore * objScore);
          if (score < scoreThreshold) continue;
          const cx = (c + bbox[idx * 4]) * stride;
          const cy = (r + bbox[idx * 4 + 1]) * stride;
          const w = Math.exp(bbox[idx * 4 + 2]) * stride;
          const h = Math.exp(bbox[idx * 4 + 3]) * stride;
          const lm: Point[] = [];
          for (let n = 0; n < 5; n++) {
            lm.push([
              ((kps[idx * 10 + 2 * n] + c) * stride) / scale,
              ((kps[idx * 10 + 2 * n + 1] + r) * stride) / scale,
            ]);
          }
          faces.push({
            box: {
              x: (cx - w / 2) / scale,
              y: (cy - h / 2) / scale,
              w: w / scale,
              h: h / scale,
            },
            landmarks: lm as DetectedFace['landmarks'],
            score,
          });
        }
      }
    }
    return nms(faces, nmsThreshold);
  }
}

function iou(a: DetectedFace['box'], b: DetectedFace['box']): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a.w * a.h + b.w * b.h - inter);
}

function nms(faces: DetectedFace[], threshold: number): DetectedFace[] {
  const sorted = [...faces].sort((a, b) => b.score - a.score);
  const keep: DetectedFace[] = [];
  for (const f of sorted) {
    if (keep.every((k) => iou(k.box, f.box) <= threshold)) keep.push(f);
  }
  return keep;
}
