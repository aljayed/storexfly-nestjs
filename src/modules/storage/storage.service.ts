import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createHash } from 'crypto';
import type { Readable } from 'stream';

interface StorageCfg {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicPrefix: string;
  enabled: boolean;
}

/** Parsed `data:` URL. */
interface DataUrl {
  mime: string;
  buffer: Buffer;
}

const DATA_URL_RE = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,(.+)$/is;

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'video/mp4': 'mp4',
  'application/pdf': 'pdf',
};

const MIME_BY_EXT: Record<string, string> = Object.fromEntries(
  Object.entries(EXT_BY_MIME).map(([mime, ext]) => [ext, mime]),
);

/**
 * S3-compatible object storage for user-uploaded media (product photos, shop
 * banners, review images, brand logos). Images arrive from the client as base64
 * `data:` URLs; {@link absorb} uploads them once to a private bucket under a
 * content-hash key and returns a same-origin `/media/...` URL that the app's
 * media proxy streams back (Nginx caches it). Content-hash keys make objects
 * immutable — safe to cache forever — and automatically de-duplicate identical
 * uploads.
 *
 * When S3 is not configured the service stays in passthrough mode: `absorb`
 * returns the original value unchanged, so the app still works with inline data
 * URLs (the pre-S3 behaviour).
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private client: S3Client | null = null;
  private cfg!: StorageCfg;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    this.cfg = this.config.getOrThrow<StorageCfg>('storage');
    if (!this.cfg.enabled) {
      this.logger.warn(
        'S3 storage not configured — media stays as inline data URLs.',
      );
      return;
    }
    this.client = new S3Client({
      endpoint: this.cfg.endpoint,
      region: this.cfg.region,
      credentials: {
        accessKeyId: this.cfg.accessKeyId,
        secretAccessKey: this.cfg.secretAccessKey,
      },
      forcePathStyle: true, // Contabo/Ceph uses path-style addressing.
    });
    this.logger.log(`S3 storage ready (bucket ${this.cfg.bucket}).`);
  }

  get enabled(): boolean {
    return Boolean(this.client);
  }

  /**
   * If `value` is a base64 `data:` URL, upload it and return the `/media/...`
   * URL to store in its place. Any other string (already a URL, a YouTube link,
   * empty) is returned unchanged, so this is safe to run over every write and
   * every existing row.
   */
  async absorb(
    value: string | null | undefined,
    folder: string,
  ): Promise<string | null | undefined> {
    if (!value) return value;
    if (!this.client) return value; // passthrough when S3 is off
    const parsed = parseDataUrl(value);
    if (!parsed) return value; // not a data URL — leave as-is
    return this.upload(parsed, folder);
  }

  /** {@link absorb} for an array of values (product/shop image lists). */
  async absorbMany(
    values: string[] | null | undefined,
    folder: string,
  ): Promise<string[] | null | undefined> {
    if (!values) return values;
    return Promise.all(values.map((v) => this.absorb(v, folder))) as Promise<
      string[]
    >;
  }

  /** Fetch an object's bytes for the media proxy. `key` excludes the folder-less prefix. */
  async getObject(
    key: string,
  ): Promise<{ body: Readable; contentType: string } | null> {
    if (!this.client) return null;
    try {
      const out = await this.client.send(
        new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }),
      );
      const ext = key.split('.').pop() ?? '';
      return {
        body: out.Body as Readable,
        contentType:
          out.ContentType ?? MIME_BY_EXT[ext] ?? 'application/octet-stream',
      };
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === 'NoSuchKey' || name === 'NotFound') return null;
      throw err;
    }
  }

  private async upload(data: DataUrl, folder: string): Promise<string> {
    const hash = createHash('sha256').update(data.buffer).digest('hex');
    const ext = EXT_BY_MIME[data.mime] ?? 'bin';
    const key = `${folder}/${hash}.${ext}`;
    await this.client!.send(
      new PutObjectCommand({
        Bucket: this.cfg.bucket,
        Key: key,
        Body: data.buffer,
        ContentType: data.mime,
        // Immutable content-hash key — long-lived cache once served.
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
    return `${this.cfg.publicPrefix}/${key}`;
  }
}

function parseDataUrl(value: string): DataUrl | null {
  const m = DATA_URL_RE.exec(value.trim());
  if (!m) return null;
  const mime = m[1].toLowerCase();
  const buffer = Buffer.from(m[2], 'base64');
  if (buffer.length === 0) return null;
  return { mime, buffer };
}
