import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsOptional, IsUUID } from 'class-validator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { SellerPrincipal } from '../../common/types/principal';
import { FaceService } from './face.service';

class FaceCurrentQuery {
  @IsOptional() @IsUUID() sessionId?: string;
}
class FaceFrameDto {
  @IsUUID() sessionId!: string;
  @IsUUID() nonce!: string;
}

/**
 * The live face check an account passes before it may open a shop.
 *
 * Deliberately not @StorefrontSession(): like opening a shop itself, this
 * belongs to an account that has already proved an email or a phone number.
 */
@ApiTags('face')
@ApiBearerAuth()
@Controller('face')
export class FaceController {
  constructor(private readonly face: FaceService) {}

  @Get('status')
  @ApiOperation({ summary: 'Whether the check is available / already passed' })
  status(@CurrentUser() user: SellerPrincipal) {
    return this.face.status(user.id);
  }

  @Post('session')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Start a live camera session; only the current prompt is returned',
  })
  session(@CurrentUser() user: SellerPrincipal) {
    return this.face.startSession(user.id);
  }

  @Get('session')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Resync the live session after a lost frame response',
  })
  current(@CurrentUser() user: SellerPrincipal, @Query() q: FaceCurrentQuery) {
    return this.face.current(user.id, q.sessionId);
  }

  @Post('frame')
  @HttpCode(200)
  @Throttle({ default: { limit: 240, ttl: 60_000 } })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileInterceptor('frame', {
      limits: {
        fileSize: 350_000,
        files: 1,
        fields: 2,
        fieldSize: 100,
        // busboy refuses once the count *reaches* this, so two fields
        // and one file need room for a fourth.
        parts: 4,
      },
    }),
  )
  @ApiOperation({
    summary:
      'Submit the next camera frame with the server-issued one-use nonce',
  })
  frame(
    @CurrentUser() user: SellerPrincipal,
    @Body() dto: FaceFrameDto,
    @UploadedFile() file?: { buffer: Buffer; mimetype: string },
  ) {
    if (!file || file.mimetype !== 'image/jpeg')
      throw new BadRequestException('A JPEG camera frame is required');
    return this.face.frame(user.id, dto.sessionId, dto.nonce, file.buffer);
  }

  @Post('dev-bypass')
  @HttpCode(200)
  @ApiOperation({ summary: 'Development only: skip the camera' })
  devBypass(@CurrentUser() user: SellerPrincipal) {
    return this.face.devBypass(user.id);
  }
}
