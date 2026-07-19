import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { PaymentsService } from './payments.service';

/** Public return leg of the bKash hosted checkout. */
@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  /**
   * bKash redirects the buyer's browser here after the hosted flow
   * (`?paymentID=…&status=success|failure|cancel`). The service executes a
   * success, voids anything else, and we bounce the buyer to the web app's
   * result page either way.
   */
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('bkash/callback')
  @ApiExcludeEndpoint()
  async bkashCallback(
    @Query('paymentID') paymentId: string | undefined,
    @Query('status') status: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const { redirectUrl } = await this.payments.handleBkashCallback(
      paymentId ?? '',
      status ?? 'failure',
    );
    res.redirect(redirectUrl);
  }
}
