import {
  Injectable,
  Logger,
  type OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AntiSpoof } from './antispoof';
import { SFace } from './sface';
import { YuNet } from './yunet';

const FILES = ['yunet.onnx', 'sface.onnx', 'antispoof.onnx'] as const;

/**
 * Owns the three ONNX models - YuNet (detection + landmarks), SFace
 * (embedding) and MiniFASNetV2 (passive anti-spoof). Loaded once at boot.
 *
 * A server without the model files (or with files that do not match the
 * pinned checksums in face-models.json) still starts: the face check reports
 * itself unavailable and the rest of the API is unaffected. Run
 * `npm run face:models` to fetch them.
 */
@Injectable()
export class FaceEngineService implements OnModuleInit {
  private readonly logger = new Logger(FaceEngineService.name);
  private models: { yunet: YuNet; sface: SFace; antispoof: AntiSpoof } | null =
    null;
  /** SHA-256 of the recognition model in use, once verified. */
  sfaceSha256: string | null = null;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.load();
    } catch (err) {
      // Never take the API down over the face check.
      this.logger.error(`Face models failed to load: ${String(err)}`);
    }
  }

  private async load(): Promise<void> {
    const dir = resolve(this.config.get<string>('face.modelsDir', 'models'));
    const manifestPath = resolve(
      this.config.get<string>('face.manifest', 'face-models.json'),
    );
    const missing = FILES.filter((f) => !existsSync(join(dir, f)));
    if (missing.length || !existsSync(manifestPath)) {
      this.logger.warn(
        `Face models missing in ${dir}${missing.length ? `: ${missing.join(', ')}` : ''} - run "npm run face:models". The face check is unavailable until then.`,
      );
      return;
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<
      string,
      { sha256: string }
    >;
    for (const file of FILES) {
      const digest = createHash('sha256')
        .update(readFileSync(join(dir, file)))
        .digest('hex');
      if (manifest[file]?.sha256 !== digest) {
        this.logger.error(
          `Face model integrity check failed: ${file}. The face check is unavailable.`,
        );
        return;
      }
    }
    const started = Date.now();
    const [yunet, sface, antispoof] = await Promise.all([
      YuNet.load(join(dir, 'yunet.onnx')),
      SFace.load(join(dir, 'sface.onnx')),
      AntiSpoof.load(join(dir, 'antispoof.onnx')),
    ]);
    this.models = { yunet, sface, antispoof };
    this.sfaceSha256 = manifest['sface.onnx'].sha256;
    this.logger.log(`Face models loaded in ${Date.now() - started}ms`);
  }

  get ready(): boolean {
    return this.models !== null;
  }

  get engines() {
    if (!this.models) {
      throw new ServiceUnavailableException({
        error: 'FaceUnavailable',
        message: 'The face check is not available right now. Try again later.',
      });
    }
    return this.models;
  }
}
