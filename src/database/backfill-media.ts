import 'dotenv/config';
import {
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createHash } from 'crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import * as schema from './schema';

/**
 * One-off migration of existing inline base64 `data:` images (in products,
 * shops, reviews, brand logos, platform settings) into S3 object storage,
 * replacing each column value with its `/media/...` URL. Idempotent: any value
 * that isn't a `data:` URL is skipped, so it's safe to run repeatedly.
 *
 * Run with: node dist/src/database/backfill-media.js
 */

const DATA_URL_RE = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,(.+)$/is;
const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
};

const endpoint = process.env.S3_ENDPOINT;
const bucket = process.env.S3_BUCKET as string;
const publicPrefix = process.env.S3_PUBLIC_PREFIX ?? '/api/media';

if (!endpoint || !bucket) {
  console.error('S3_ENDPOINT / S3_BUCKET not set — aborting.');
  process.exit(1);
}

const s3 = new S3Client({
  endpoint,
  region: process.env.S3_REGION ?? 'eu2',
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY as string,
    secretAccessKey: process.env.S3_SECRET_KEY as string,
  },
  forcePathStyle: true,
});

let uploaded = 0;
let skipped = 0;

/** Upload a single data URL and return its /media URL; passthrough otherwise. */
async function absorb(
  value: string | null | undefined,
  folder: string,
): Promise<string | null | undefined> {
  if (!value) return value;
  const m = DATA_URL_RE.exec(value.trim());
  if (!m) {
    skipped++;
    return value;
  }
  const mime = m[1].toLowerCase();
  const buffer = Buffer.from(m[2], 'base64');
  if (buffer.length === 0) return value;
  const hash = createHash('sha256').update(buffer).digest('hex');
  const ext = EXT_BY_MIME[mime] ?? 'bin';
  const key = `${folder}/${hash}.${ext}`;
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: mime,
      CacheControl: 'public, max-age=31536000, immutable',
    }),
  );
  uploaded++;
  return `${publicPrefix}/${key}`;
}

async function absorbMany(
  values: string[] | null | undefined,
  folder: string,
): Promise<string[] | null | undefined> {
  if (!values) return values;
  const out: string[] = [];
  for (const v of values) {
    const r = await absorb(v, folder);
    if (r) out.push(r);
  }
  return out;
}

async function main(): Promise<void> {
  const client = postgres(process.env.DATABASE_URL as string, { max: 1 });
  const db = drizzle(client, { schema });
  const { products, shops, reviews, brandLogos, platformSettings } = schema;

  console.log('Backfilling product images…');
  for (const p of await db.select().from(products)) {
    const images = await absorbMany(p.images, 'products');
    if (JSON.stringify(images) !== JSON.stringify(p.images)) {
      await db
        .update(products)
        .set({ images: images ?? null })
        .where(eq(products.id, p.id));
    }
  }

  console.log('Backfilling shop banners / floating images…');
  for (const s of await db.select().from(shops)) {
    const banners = await absorbMany(s.bannerImages, 'shops');
    const floating = await absorbMany(s.floatingImages, 'shops');
    if (
      JSON.stringify(banners) !== JSON.stringify(s.bannerImages) ||
      JSON.stringify(floating) !== JSON.stringify(s.floatingImages)
    ) {
      await db
        .update(shops)
        .set({
          bannerImages: banners ?? null,
          floatingImages: floating ?? null,
        })
        .where(eq(shops.id, s.id));
    }
  }

  console.log('Backfilling review images…');
  for (const r of await db.select().from(reviews)) {
    const imageUrl = await absorb(r.imageUrl, 'reviews');
    if (imageUrl !== r.imageUrl) {
      await db
        .update(reviews)
        .set({ imageUrl: imageUrl ?? null })
        .where(eq(reviews.id, r.id));
    }
  }

  console.log('Backfilling brand logos + platform settings…');
  for (const l of await db.select().from(brandLogos)) {
    const dataUrl = await absorb(l.dataUrl, 'branding');
    if (dataUrl && dataUrl !== l.dataUrl) {
      await db
        .update(brandLogos)
        .set({ dataUrl })
        .where(eq(brandLogos.id, l.id));
    }
  }
  for (const ps of await db.select().from(platformSettings)) {
    const logoLight = await absorb(ps.logoLight, 'branding');
    const logoDark = await absorb(ps.logoDark, 'branding');
    const favicon = await absorb(ps.favicon, 'branding');
    if (
      logoLight !== ps.logoLight ||
      logoDark !== ps.logoDark ||
      favicon !== ps.favicon
    ) {
      await db
        .update(platformSettings)
        .set({
          logoLight: logoLight ?? null,
          logoDark: logoDark ?? null,
          favicon: favicon ?? null,
        })
        .where(eq(platformSettings.id, ps.id));
    }
  }

  // Reclaim the space the base64 columns used to occupy.
  console.log('VACUUM FULL on rewritten tables…');
  await db.execute(sql`VACUUM FULL products, shops, reviews, brand_logos, platform_settings`);

  console.log(`Done. Uploaded ${uploaded} image(s); left ${skipped} non-data value(s) untouched.`);
  await client.end({ timeout: 5 });
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
