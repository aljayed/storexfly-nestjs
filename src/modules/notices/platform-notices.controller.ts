import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { PlatformJwtAuthGuard } from '../../common/guards/platform-jwt-auth.guard';
import {
  CreateNoticeDto,
  NoticeListResponse,
  NoticeResponse,
  UpdateNoticeDto,
} from './dto/notice.dto';
import { NoticesService } from './notices.service';

/** Operator console: publish and manage seller-facing announcements. */
@ApiTags('platform-admin')
@Public()
@UseGuards(PlatformJwtAuthGuard)
@ApiBearerAuth()
@Controller('platform/notices')
export class PlatformNoticesController {
  constructor(private readonly notices: NoticesService) {}

  @Get()
  @ApiOperation({ summary: 'Platform admin: all notices, newest first' })
  @ApiOkResponse({ type: NoticeListResponse })
  list() {
    return this.notices.listAll();
  }

  @Post()
  @ApiOperation({
    summary: 'Platform admin: publish a notice (global or per-shop)',
  })
  @ApiOkResponse({ type: NoticeResponse })
  create(@Body() dto: CreateNoticeDto) {
    return this.notices.create(dto.message, dto.tone, dto.shopId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Platform admin: edit / (de)activate a notice' })
  @ApiOkResponse({ type: NoticeResponse })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateNoticeDto) {
    return this.notices.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Platform admin: delete a notice' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.notices.remove(id);
  }
}
