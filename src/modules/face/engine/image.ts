import sharp from 'sharp';

/** Packed 8-bit RGB pixels, row-major. */
export interface RgbImage {
  data: Uint8Array;
  width: number;
  height: number;
}

export async function decodeImage(buf: Buffer): Promise<RgbImage> {
  // Compressed-byte limits alone do not prevent decompression bombs.
  const input = sharp(buf, {
    limitInputPixels: 1280 * 1280,
    failOn: 'warning',
  });
  const metadata = await input.metadata();
  if (
    metadata.format !== 'jpeg' ||
    !metadata.width ||
    !metadata.height ||
    metadata.width < 160 ||
    metadata.height < 160 ||
    metadata.width > 1280 ||
    metadata.height > 1280 ||
    (metadata.pages ?? 1) !== 1
  ) {
    throw new Error(
      'Expected a single JPEG camera frame between 160 and 1280 pixels',
    );
  }
  const { data, info } = await input
    .rotate() // respect EXIF orientation from phone cameras
    .resize({
      width: 640,
      height: 640,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
}

/** Conservative quality floor, applied to a fixed-size aligned face crop.
 * These are engineering defaults, not calibrated biometric accuracy claims. */
export type QualityIssue = 'too_dark' | 'too_bright' | 'blurry';

export function faceQuality(img: RgbImage): boolean {
  return faceQualityIssue(img) === null;
}

/** What is wrong with an aligned face crop, so the person can fix it. */
export function faceQualityIssue(img: RgbImage): QualityIssue | null {
  const gray = new Float32Array(img.width * img.height);
  let brightness = 0,
    clipped = 0;
  for (let i = 0; i < gray.length; i++) {
    const v =
      0.299 * img.data[i * 3] +
      0.587 * img.data[i * 3 + 1] +
      0.114 * img.data[i * 3 + 2];
    gray[i] = v;
    brightness += v;
    if (v < 8 || v > 247) clipped++;
  }
  brightness /= gray.length;
  let sum = 0,
    squares = 0,
    count = 0;
  for (let y = 1; y < img.height - 1; y++) {
    for (let x = 1; x < img.width - 1; x++) {
      const i = y * img.width + x;
      const lap =
        4 * gray[i] -
        gray[i - 1] -
        gray[i + 1] -
        gray[i - img.width] -
        gray[i + img.width];
      sum += lap;
      squares += lap * lap;
      count++;
    }
  }
  const variance = squares / count - (sum / count) ** 2;
  if (brightness < 35) return 'too_dark';
  if (brightness > 220) return 'too_bright';
  if (clipped / gray.length >= 0.35)
    return brightness < 128 ? 'too_dark' : 'too_bright';
  if (variance < 18) return 'blurry';
  return null;
}

export async function resizeImage(
  img: RgbImage,
  width: number,
  height: number,
): Promise<RgbImage> {
  const { data, info } = await sharp(Buffer.from(img.data), {
    raw: { width: img.width, height: img.height, channels: 3 },
  })
    .resize(width, height, { fit: 'fill', kernel: 'lanczos3' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
}

/** OpenCV BORDER_REFLECT_101: gfedcb|abcdefgh|gfedcba */
function reflect101(i: number, n: number): number {
  if (n === 1) return 0;
  while (i < 0 || i >= n) {
    if (i < 0) i = -i;
    if (i >= n) i = 2 * n - 2 - i;
  }
  return i;
}

/** Square crop centred on a box, expanded by `factor`, edges filled by reflection. */
export function cropSquareReflect(
  img: RgbImage,
  box: { x: number; y: number; w: number; h: number },
  factor: number,
): RgbImage {
  const size = Math.max(1, Math.round(Math.max(box.w, box.h) * factor));
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const x0 = Math.round(cx - size / 2);
  const y0 = Math.round(cy - size / 2);
  const out = new Uint8Array(size * size * 3);
  for (let y = 0; y < size; y++) {
    const sy = reflect101(y0 + y, img.height);
    for (let x = 0; x < size; x++) {
      const sx = reflect101(x0 + x, img.width);
      const si = (sy * img.width + sx) * 3;
      const di = (y * size + x) * 3;
      out[di] = img.data[si];
      out[di + 1] = img.data[si + 1];
      out[di + 2] = img.data[si + 2];
    }
  }
  return { data: out, width: size, height: size };
}

/**
 * Affine warp with bilinear sampling (like cv2.warpAffine, INTER_LINEAR, constant 0 border).
 * `m` maps source -> destination: [a, b, c, d, e, f] meaning x' = a x + b y + c, y' = d x + e y + f.
 */
export function warpAffine(
  img: RgbImage,
  m: [number, number, number, number, number, number],
  outW: number,
  outH: number,
): RgbImage {
  const [a, b, c, d, e, f] = m;
  const det = a * e - b * d;
  // inverse transform: destination -> source
  const ia = e / det;
  const ib = -b / det;
  const id = -d / det;
  const ie = a / det;
  const ic = -(ia * c + ib * f);
  const iff = -(id * c + ie * f);
  const out = new Uint8Array(outW * outH * 3);
  const { width: W, height: H, data } = img;
  for (let v = 0; v < outH; v++) {
    for (let u = 0; u < outW; u++) {
      const sx = ia * u + ib * v + ic;
      const sy = id * u + ie * v + iff;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      const di = (v * outW + u) * 3;
      for (let ch = 0; ch < 3; ch++) {
        const px = (x: number, y: number) =>
          x < 0 || y < 0 || x >= W || y >= H ? 0 : data[(y * W + x) * 3 + ch];
        const top = px(x0, y0) * (1 - fx) + px(x0 + 1, y0) * fx;
        const bottom = px(x0, y0 + 1) * (1 - fx) + px(x0 + 1, y0 + 1) * fx;
        out[di + ch] = Math.round(top * (1 - fy) + bottom * fy);
      }
    }
  }
  return { data: out, width: outW, height: outH };
}

/** HWC uint8 RGB -> CHW float32, optionally swapping to BGR and scaling. */
export function toChwTensor(
  img: RgbImage,
  opts: { bgr?: boolean; scale?: number } = {},
): Float32Array {
  const { width: W, height: H, data } = img;
  const scale = opts.scale ?? 1;
  const plane = W * H;
  const out = new Float32Array(plane * 3);
  for (let i = 0; i < plane; i++) {
    const r = data[i * 3] * scale;
    const g = data[i * 3 + 1] * scale;
    const b = data[i * 3 + 2] * scale;
    if (opts.bgr) {
      out[i] = b;
      out[plane + i] = g;
      out[2 * plane + i] = r;
    } else {
      out[i] = r;
      out[plane + i] = g;
      out[2 * plane + i] = b;
    }
  }
  return out;
}

/** Mean absolute pixel difference between two same-size images (0..255). */
export function meanAbsDiff(a: RgbImage, b: RgbImage): number {
  if (a.width !== b.width || a.height !== b.height) return 255;
  let sum = 0;
  for (let i = 0; i < a.data.length; i++)
    sum += Math.abs(a.data[i] - b.data[i]);
  return sum / a.data.length;
}
