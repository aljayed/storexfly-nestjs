import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { PlatformJwtAuthGuard } from '../../common/guards/platform-jwt-auth.guard';
import type { PlatformPrincipal } from '../../common/types/principal';
import { FaceReviewService } from '../face/face-review.service';

class FaceReviewDto {
  @IsString()
  @MinLength(5)
  @MaxLength(1000)
  note!: string;
}

/** Face checks that matched another account, and what to do about them. */
@ApiTags('platform-admin')
@Public()
@UseGuards(PlatformJwtAuthGuard)
@ApiBearerAuth()
@Controller('platform/face-checks')
export class PlatformFaceController {
  constructor(private readonly review: FaceReviewService) {}

  @Get()
  @ApiOperation({ summary: 'Platform admin: duplicate and near-match checks' })
  list() {
    return this.review.flagged();
  }

  @Post(':id/release')
  @ApiOperation({
    summary: 'Platform admin: lift a hold so the account may try again',
  })
  async release(
    @CurrentUser() actor: PlatformPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: FaceReviewDto,
  ) {
    await this.review.release(id, actor.email, dto.note);
    return { ok: true };
  }

  @Post('accounts/:userId/reset')
  @ApiOperation({
    summary: "Platform admin: forget an account's registered face",
  })
  async reset(
    @CurrentUser() actor: PlatformPrincipal,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: FaceReviewDto,
  ) {
    await this.review.resetFace(userId, actor.email, dto.note);
    return { ok: true };
  }
}
