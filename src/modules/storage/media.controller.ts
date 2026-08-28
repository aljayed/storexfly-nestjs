import {
  Controller,
  Get,
  Headers,
  NotFoundException,
  Param,
  Query,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import sharp from 'sharp';
import { Public } from '../../common/decorators/public.decorator';
import { StorageService } from './storage.service';

/* Fixed set of resize widths so `?w=` can't be abused to mint unlimited cache
   variants (Nginx keys on the full URI). Anything else serves the original. */
const RESIZE_WIDTHS = new Set([240, 480, 960]);

/* Formats sharp can safely resize without losing something (gif animation,
   svg vectors) - everything else streams through untouched. */
const RESIZABLE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);

/* WebP re-encoding is worth it for still photographs, which is what sellers
   upload. Deliberately excludes gif (converting would flatten the animation)
   and svg (vector - rasterising it makes the file bigger and blurry). */
const WEBP_CONVERTIBLE = new Set(['image/jpeg', 'image/png']);

/* Measured on a real product photo: 1140x805 JPEG, 89.2 KB -> 54.3 KB. At
   ?w=480 it takes the thumbnail from 21.6 KB to 14.6 KB. Above ~85 the
   saving thins out; below ~70 gradients start to band. */
const WEBP_QUALITY = 80;

/* The admin re-encodes seller photos to WebP in the browser before upload, so
   the stored object is now often WebP itself. A client that does not advertise
   WebP has to be handed something it can decode, which means transcoding back.
   Higher than WEBP_QUALITY because this is a second lossy pass over an already
   lossy source, and it is a rare path - not worth being stingy on. */
const JPEG_FALLBACK_QUALITY = 88;

/**
 * Public media proxy. Streams private-bucket objects back to the browser so the
 * bucket needs no public access; Nginx caches these responses (content-hash
 * keys make them immutable), so S3 is hit at most once per object.
 *
 * Served at `/api/media/*` (the global 'api' prefix + this controller's path).
 */
@ApiTags('media')
@Controller('media')
export class MediaController {
  constructor(private readonly storage: StorageService) {}

  @Public()
  @Get('*key')
  @ApiOperation({ summary: 'Stream an uploaded media object' })
  async get(
    @Param('key') keyParam: string | string[],
    @Query('w') w: string | undefined,
    @Query('s') s: string | undefined,
    // Nginx normalises the browser's Accept into 1/0 and puts the *same* value
    // in its cache key (see the /api/media/ block in the frontend nginx.conf).
    // Reading its flag rather than re-parsing Accept here is what guarantees
    // the cache key and this decision can never disagree - if they did, one
    // visitor's WebP would be stored under the key another visitor's browser
    // reads as JPEG. The Accept fallback covers direct hits that bypass nginx.
    @Headers('x-accept-webp') webpFlag: string | undefined,
    @Headers('accept') accept: string | undefined,
    @Res() res: Response,
  ) {
    // NestJS gives the wildcard as segments; rejoin to the original S3 key.
    const key = Array.isArray(keyParam) ? keyParam.join('/') : keyParam;
    if (!key || key.includes('..')) {
      throw new NotFoundException();
    }
    const obj = await this.storage.getObject(key);
    if (!obj) {
      throw new NotFoundException();
    }

    const wantsWebp =
      webpFlag !== undefined
        ? webpFlag === '1'
        : (accept ?? '').includes('image/webp');
    const toWebp = wantsWebp && WEBP_CONVERTIBLE.has(obj.contentType);
    // The reverse of toWebp: a stored WebP going to a client that never asked
    // for one. Without this the browser is handed bytes it cannot render.
    const fromWebp = !wantsWebp && obj.contentType === 'image/webp';

    res.setHeader(
      'Content-Type',
      toWebp ? 'image/webp' : fromWebp ? 'image/jpeg' : obj.contentType,
    );
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    // The response body now depends on a request header, so say so. Nginx
    // keys on its own normalised flag, but any cache between us and the
    // browser has to know not to reuse one variant for the other.
    res.setHeader('Vary', 'Accept');

    // `w` scales to a width keeping aspect; `s` centre-crops to an exact
    // square (link-preview thumbnails). `s` wins when both are sent.
    const square = Number(s);
    const width = Number(w);
    const size = RESIZE_WIDTHS.has(square)
      ? { width: square, height: square, fit: 'cover' as const }
      : RESIZE_WIDTHS.has(width)
        ? { width, withoutEnlargement: true }
        : null;

    const resizable = size && RESIZABLE.has(obj.contentType);
    if (resizable || toWebp || fromWebp) {
      const pipeline = sharp().rotate(); // EXIF orientation before it's stripped
      if (resizable) pipeline.resize(size);
      if (toWebp) pipeline.webp({ quality: WEBP_QUALITY });
      // JPEG has no alpha. Our own uploads keep transparent artwork as PNG, so
      // this should not fire, but a WebP that does carry alpha would otherwise
      // composite onto black instead of the page.
      if (fromWebp) {
        pipeline
          .flatten({ background: '#ffffff' })
          .jpeg({ quality: JPEG_FALLBACK_QUALITY });
      }
      pipeline.on('error', () => res.destroy());
      obj.body.pipe(pipeline).pipe(res);
      return;
    }
    obj.body.pipe(res);
  }
}
