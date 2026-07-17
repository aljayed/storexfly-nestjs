import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { StorageService } from './storage.service';

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
  async get(@Param('key') keyParam: string | string[], @Res() res: Response) {
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
    obj.body.pipe(res);
  }
}
