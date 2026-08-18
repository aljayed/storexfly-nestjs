import {
  All,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import type { SslcommerzCallbackBody } from '../gateways/sslcommerz.service';
import { PaymentsService } from './payments.service';

/**
 * Public return leg of the hosted checkouts. Every route here is reached by
 * the gateway (or the buyer's browser under its instruction), never by the
 * web app, and none of them is trusted on its word - see PaymentsService.
 */
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

  /**
   * SSLCommerz hands the buyer back as a form POST to one of three URLs,
   * carrying `tran_id` and (on success) `val_id`. Which URL it chose is only
   * a claim; a success is put to the validator before the order moves.
   *
   * `@All` rather than `@Post`: the gateway falls back to a plain GET when
   * the browser cannot carry the POST across (an interstitial, a wallet app
   * handing the tab back), and a buyer who lands on the wrong verb would
   * otherwise see a 404 instead of their order.
   */
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @All('sslcommerz/success')
  @ApiExcludeEndpoint()
  async sslcommerzSuccess(
    @Body() body: SslcommerzCallbackBody,
    @Query() query: SslcommerzCallbackBody,
    @Res() res: Response,
  ): Promise<void> {
    await this.sslcommerzReturn('success', body, query, res);
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @All('sslcommerz/fail')
  @ApiExcludeEndpoint()
  async sslcommerzFail(
    @Body() body: SslcommerzCallbackBody,
    @Query() query: SslcommerzCallbackBody,
    @Res() res: Response,
  ): Promise<void> {
    await this.sslcommerzReturn('fail', body, query, res);
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @All('sslcommerz/cancel')
  @ApiExcludeEndpoint()
  async sslcommerzCancel(
    @Body() body: SslcommerzCallbackBody,
    @Query() query: SslcommerzCallbackBody,
    @Res() res: Response,
  ): Promise<void> {
    await this.sslcommerzReturn('cancel', body, query, res);
  }

  /**
   * SSLCommerz's server-to-server notification. Nobody is waiting on the
   * other end, so it answers a bare 200 and never redirects - anything else
   * and the gateway keeps retrying a message that was already handled.
   */
  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post('sslcommerz/ipn')
  @HttpCode(200)
  @ApiExcludeEndpoint()
  async sslcommerzIpn(
    @Body() body: SslcommerzCallbackBody,
  ): Promise<{ received: true }> {
    await this.payments.handleSslcommerzIpn(body ?? {});
    return { received: true };
  }

  /** Body on a POST, query string on the GET fallback - same fields either way. */
  private async sslcommerzReturn(
    outcome: 'success' | 'fail' | 'cancel',
    body: SslcommerzCallbackBody,
    query: SslcommerzCallbackBody,
    res: Response,
  ): Promise<void> {
    const fields = { ...(query ?? {}), ...(body ?? {}) };
    const { redirectUrl } = await this.payments.handleSslcommerzReturn(
      outcome,
      fields,
    );
    res.redirect(redirectUrl);
  }
}
