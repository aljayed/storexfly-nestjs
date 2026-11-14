import {
  Injectable,
  ServiceUnavailableException,
  HttpException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { FaceCheckFailed } from '../face-errors';
import { FaceEngineService } from './face-engine.service';
import { decodeImage, faceQualityIssue } from './image';
import { isFrontal, yawRatio } from './pose';

export interface FrameAnalysis {
  hash: string;
  yaw: number;
  frontal: boolean;
  embedding: number[];
  liveness: number | null;
}

@Injectable()
export class FrameAnalysisService {
  /** Frames analysed at once (each model already uses 2 threads). */
  private static readonly SLOTS = 2;
  /** Frames that may wait for a slot, and for how long, before a 429. */
  private static readonly QUEUE = 12;
  private static readonly WAIT_MS = 2_500;
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly engine: FaceEngineService) {}

  async analyse(buffer: Buffer): Promise<FrameAnalysis> {
    await this.acquire();
    try {
      return await this.process(buffer);
    } finally {
      this.release();
    }
  }

  /**
   * A short queue: several people checking at once take turns instead of
   * failing. Only a long backlog answers 429, which the client retries.
   */
  private acquire(): Promise<void> {
    if (this.active < FrameAnalysisService.SLOTS) {
      this.active++;
      return Promise.resolve();
    }
    if (this.waiting.length >= FrameAnalysisService.QUEUE)
      return Promise.reject(busy());
    return new Promise((resolve, reject) => {
      const go = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        const i = this.waiting.indexOf(go);
        if (i >= 0) this.waiting.splice(i, 1);
        reject(busy());
      }, FrameAnalysisService.WAIT_MS);
      this.waiting.push(go);
    });
  }

  /** Hand the slot straight to the next frame in line, if any. */
  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }

  private async process(buffer: Buffer): Promise<FrameAnalysis> {
    const image = await decodeImage(buffer);
    const { yunet, sface, antispoof } = this.engine.engines;
    const faces = await yunet.detect(image);
    if (!faces.length) throw new FaceCheckFailed('no_face');
    if (faces.length !== 1) throw new FaceCheckFailed('multiple_faces');
    const face = faces[0];
    const { x, y, w, h } = face.box;
    // Same frames accepted as before; the reason is split so the person is
    // told which way to move rather than a catch-all.
    if (x < 0 || y < 0 || x + w > image.width || y + h > image.height) {
      throw new FaceCheckFailed(
        w > image.width * 0.55 || h > image.height * 0.75
          ? 'too_close'
          : 'off_frame',
      );
    }
    if (w < Math.max(96, image.width * 0.18) || h < 96) {
      throw new FaceCheckFailed('too_far');
    }
    const yaw = yawRatio(face);
    if (!Number.isFinite(yaw)) throw new FaceCheckFailed('pose');
    const frontal = isFrontal(yaw);
    const aligned = sface.align(image, face);
    const issue = faceQualityIssue(aligned);
    if (issue) throw new FaceCheckFailed(issue);
    const embedding = Array.from(await sface.embedAligned(aligned));
    const liveness = frontal
      ? await antispoof.realProbability(image, face)
      : null;
    const norm = Math.hypot(...embedding);
    if (
      !Number.isFinite(yaw) ||
      embedding.length !== 128 ||
      embedding.some((v) => !Number.isFinite(v)) ||
      norm < 0.99 ||
      norm > 1.01 ||
      (liveness !== null &&
        (!Number.isFinite(liveness) || liveness < 0 || liveness > 1))
    ) {
      throw new ServiceUnavailableException(
        'The face check could not be processed. Please try again later.',
      );
    }
    return {
      // Hash decoded pixels, so changing JPEG metadata cannot evade equality.
      hash: createHash('sha256')
        .update(`${image.width}:${image.height}:`)
        .update(image.data)
        .digest('hex'),
      yaw,
      frontal,
      embedding,
      liveness,
    };
  }
}

function busy(): HttpException {
  return new HttpException('Camera checks are busy. Retrying shortly.', 429);
}
