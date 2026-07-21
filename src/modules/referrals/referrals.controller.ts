import { Controller, Get, Param } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { ReferralsService } from './referrals.service';
import { ReferralResolveResponse } from './dto/referral-link.response';

/** Public leg of referral links: the storefront resolves /r/<slug> here. */
@ApiTags('referrals')
@Controller('referrals')
export class ReferralsController {
  constructor(private readonly referrals: ReferralsService) {}

  @Public()
  @Get(':slug')
  @ApiOperation({
    summary: 'Resolve a referral link to its coupon and first-month quote',
  })
  @ApiOkResponse({ type: ReferralResolveResponse })
  resolve(@Param('slug') slug: string) {
    return this.referrals.resolve(slug);
  }
}
