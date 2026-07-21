import {
  Controller,
  Get,
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
   svg vectors) — everything else streams through untouched. */
const RESIZABLE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);

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
    res.setHeader('Content-Type', obj.contentType);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

    // `w` scales to a width keeping aspect; `s` centre-crops to an exact
    // square (link-preview thumbnails). `s` wins when both are sent.
    const square = Number(s);
    const width = Number(w);
    const size = RESIZE_WIDTHS.has(square)
      ? { width: square, height: square, fit: 'cover' as const }
      : RESIZE_WIDTHS.has(width)
        ? { width, withoutEnlargement: true }
        : null;
    if (size && RESIZABLE.has(obj.contentType)) {
      const resizer = sharp()
        .rotate() // honour EXIF orientation before it's stripped
        .resize(size);
      resizer.on('error', () => res.destroy());
      obj.body.pipe(resizer).pipe(res);
      return;
    }
    obj.body.pipe(res);
  }
}
