import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { PlatformJwtAuthGuard } from '../../common/guards/platform-jwt-auth.guard';
import { BlockedWordsService } from '../blocked-words/blocked-words.service';
import { CreateBlockedWordDto } from '../blocked-words/dto/blocked-word.dto';

/**
 * Manage the words rejected in shop names/handles and seller/buyer display
 * names - profanity plus brand-protection terms (e.g. "hoomri").
 */
@ApiTags('platform-admin')
@Public()
@UseGuards(PlatformJwtAuthGuard)
@ApiBearerAuth()
@Controller('platform/blocked-words')
export class PlatformBlockedWordsController {
  constructor(private readonly blockedWords: BlockedWordsService) {}

  @Get()
  @ApiOperation({ summary: 'Platform admin: list blocked words' })
  list() {
    return this.blockedWords.list();
  }

  @Post()
  @ApiOperation({ summary: 'Platform admin: add a blocked word' })
  add(@Body() dto: CreateBlockedWordDto) {
    return this.blockedWords.add(dto.word);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Platform admin: remove a blocked word' })
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.blockedWords.remove(id);
    return { ok: true };
  }
}
