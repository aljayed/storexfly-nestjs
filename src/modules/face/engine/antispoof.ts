import * as ort from 'onnxruntime-node';
import { RgbImage, cropSquareReflect, resizeImage, toChwTensor } from './image';
import type { DetectedFace } from './yunet';

const SIZE = 128;
const EXPANSION = 1.5;

/**
 * Passive anti-spoofing (MiniFASNetV2, Apache-2.0, suriAI/face-antispoof-onnx).
 * Detects printed photos and screens held up to the camera.
 * Input: square face crop expanded 1.5×, reflect-padded, 128×128 RGB in [0,1].
 * Output logits: [real, spoof].
 */
export class AntiSpoof {
  private constructor(private readonly session: ort.InferenceSession) {}

  static async load(path: string): Promise<AntiSpoof> {
    return new AntiSpoof(
      await ort.InferenceSession.create(path, {
        intraOpNumThreads: 2,
        interOpNumThreads: 1,
        // Errors only: the stock SFace graph logs ~100 harmless warnings.
        logSeverityLevel: 3,
      }),
    );
  }

  /** Probability (0..1) that the face is a live person rather than a photo/screen. */
  async realProbability(img: RgbImage, face: DetectedFace): Promise<number> {
    const crop = cropSquareReflect(img, face.box, EXPANSION);
    const resized = await resizeImage(crop, SIZE, SIZE);
    const tensor = new ort.Tensor(
      'float32',
      toChwTensor(resized, { scale: 1 / 255 }),
      [1, 3, SIZE, SIZE],
    );
    const out = await this.session.run({ input: tensor });
    const [real, spoof] = out.output.data as Float32Array;
    return 1 / (1 + Math.exp(-(real - spoof)));
  }
}
