import {
  Body,
  Controller,
  Delete,
  Get,
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
import { BrandingService } from '../branding/branding.service';
import {
  AddLogoDto,
  BrandingResponse,
  LogoResponse,
  UpdateBrandingDto,
} from '../branding/dto/branding.dto';

/**
 * Brand wordmark + image logo. The GET is public so every surface - including
 * the unauthenticated storefront - can render the current brand; the writes and
 * the gallery listing are restricted to a logged-in platform operator.
 */
@ApiTags('platform-admin')
@Controller('platform/branding')
export class PlatformBrandingController {
  constructor(private readonly branding: BrandingService) {}

  @Get()
  @Public()
  @ApiOperation({ summary: 'Public: current brand (wordmark + logo)' })
  @ApiOkResponse({ type: BrandingResponse })
  get() {
    return this.branding.get();
  }

  @Patch()
  @Public()
  @UseGuards(PlatformJwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Platform admin: update the brand' })
  @ApiOkResponse({ type: BrandingResponse })
  update(@Body() dto: UpdateBrandingDto) {
    return this.branding.update(dto);
  }

  @Get('logos')
  @Public()
  @UseGuards(PlatformJwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Platform admin: recent logo images' })
  @ApiOkResponse({ type: [LogoResponse] })
  logos() {
    return this.branding.listLogos();
  }

  @Post('logos')
  @Public()
  @UseGuards(PlatformJwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Platform admin: upload a logo and make it active' })
  @ApiOkResponse({ type: BrandingResponse })
  addLogo(@Body() dto: AddLogoDto) {
    return this.branding.addLogo(dto.dataUrl, dto.theme);
  }

  @Delete('logos/:id')
  @Public()
  @UseGuards(PlatformJwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Platform admin: remove a logo image' })
  @ApiOkResponse({ type: BrandingResponse })
  removeLogo(@Param('id', ParseUUIDPipe) id: string) {
    return this.branding.removeLogo(id);
  }
}
