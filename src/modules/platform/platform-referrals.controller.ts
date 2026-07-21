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
import { ReferralsService } from '../referrals/referrals.service';
import {
  CreateReferralLinkDto,
  UpdateReferralLinkDto,
} from '../referrals/dto/create-referral-link.dto';
import { ReferralLinkResponse } from '../referrals/dto/referral-link.response';

/** Referral-link management from the platform-admin console. */
@ApiTags('platform-admin')
@Public()
@UseGuards(PlatformJwtAuthGuard)
@ApiBearerAuth()
@Controller('platform/referrals')
export class PlatformReferralsController {
  constructor(private readonly referrals: ReferralsService) {}

  @Get()
  @ApiOperation({ summary: 'Platform admin: list all referral links' })
  @ApiOkResponse({ type: [ReferralLinkResponse] })
  list() {
    return this.referrals.list();
  }

  @Post()
  @ApiOperation({ summary: 'Platform admin: create a referral link' })
  @ApiOkResponse({ type: ReferralLinkResponse })
  create(@Body() dto: CreateReferralLinkDto) {
    return this.referrals.create(dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Platform admin: activate/deactivate a referral link',
  })
  @ApiOkResponse({ type: ReferralLinkResponse })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateReferralLinkDto,
  ) {
    return this.referrals.setActive(id, dto.active ?? true);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Platform admin: delete a referral link' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.referrals.remove(id);
  }
}
