import { timingSafeEqual } from 'node:crypto';
import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import type { CarrybeeWebhookBody } from '../gateways/carrybee-events';
import { CourierSettingsService } from '../gateways/courier-settings.service';
import { OrdersService } from './orders.service';

/** The header CarryBee signs its callbacks with, and expects echoed back. */
const CB_HEADER = 'x-cb-webhook-integration-header';

/** The event CarryBee posts when verifying the endpoint on registration. */
const INTEGRATION_EVENT = 'webhook.integration';

/**
 * CarryBee delivery callbacks - the channel that actually moves an order past
 * 'HandedOver'. Public by necessity (CarryBee calls it unauthenticated) and
 * guarded by the secret registered with the webhook: with none stored nothing
 * is accepted at all, so a half-configured integration fails closed rather
 * than trusting the internet.
 *
 * CarryBee's requirements for the registration handshake are answered here in
 * full - 202, and the secret echoed back in the same header it arrived in.
 *
 * Everything else answers 202 too, but for a different reason than before:
 * the callback is now written down before it is acted on, so a 202 means
 * "recorded", not "understood". A processing bug no longer loses the event -
 * the sweep retries it from the log - and a retry storm from CarryBee was
 * never going to fix our side anyway.
 */
@ApiExcludeController()
@Public()
@Controller('webhooks/carrybee')
export class CourierWebhookController {
  private readonly logger = new Logger(CourierWebhookController.name);

  constructor(
    private readonly orders: OrdersService,
    private readonly courierSettings: CourierSettingsService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async receive(
    @Headers(CB_HEADER) presented: string | undefined,
    @Body() body: CarrybeeWebhookBody,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ error: boolean; message: string }> {
    // The webhook is registered per environment, each with its own secret,
    // and the callback says nothing about which one sent it - so any
    // configured secret is accepted, and the matched one is echoed.
    const secrets = await this.courierSettings.carrybeeWebhookSecrets();
    const matched = secrets.find((s) => matches(s, presented));
    if (!matched) {
      this.logger.warn(
        `Rejected a CarryBee webhook with a ${secrets.length ? 'bad' : 'unconfigured'} secret`,
      );
      throw new UnauthorizedException('Invalid webhook secret');
    }
    // CarryBee's integration check requires the secret echoed back verbatim.
    // Only ever sent to a caller that already proved it knows the value.
    res.setHeader(CB_HEADER, matched);

    // The registration handshake is an ordinary event by name, carrying
    // nothing else. Answering it is the whole contract.
    if (!body?.event || body.event === INTEGRATION_EVENT) {
      return { error: false, message: 'Webhook verified' };
    }
    // Recorded first, acted on second: the log is what makes losing one
    // impossible, and what the retry sweep works from.
    await this.orders.recordCourierEvent(body);
    return { error: false, message: 'Accepted' };
  }
}

/** Constant-time compare so the secret can't be recovered by timing. */
function matches(expected: string, presented: string | undefined): boolean {
  if (!presented) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}
