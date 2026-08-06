import { timingSafeEqual } from 'node:crypto';
import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';
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
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ error: boolean; message: string }> {
    const expected = await this.courierSettings.carrybeeWebhookSecret();
    // Both cases are a 401 - the caller has not proved anything either way -
    // but they need very different fixes, and CarryBee's own form reports only
    // the status code. Saying which is which in the body is what turns "your
    // endpoint returned 401" into something actionable without shell access.
    if (!expected) {
      this.logger.warn(
        'Rejected a CarryBee webhook: no webhook secret is configured yet',
      );
      throw new UnauthorizedException(
        'No CarryBee webhook secret is configured on this platform yet. Save it in the operator console (Couriers → CarryBee → Webhook secret) before registering the webhook.',
      );
    }

    const isHandshake = !body?.event || body.event === INTEGRATION_EVENT;
    if (!matches(expected, presented)) {
      // CarryBee's registration ping arrives with no secret header at all,
      // whatever their docs say - it only checks that our reply carries one.
      // Answering it therefore means handing the secret to a caller that has
      // proved nothing, so it is allowed only inside a window the operator
      // opened seconds ago, only for the handshake, and only once.
      if (
        isHandshake &&
        (await this.courierSettings.carrybeeRegistrationOpen())
      ) {
        await this.courierSettings.closeCarrybeeRegistration();
        res.setHeader(CB_HEADER, expected);
        this.logger.log(
          'Answered a CarryBee registration handshake under the open window; window now shut',
        );
        return { error: false, message: 'Webhook verified' };
      }
      // Header names only, never values - enough to see what CarryBee
      // actually sends without writing anyone's secret to the log.
      this.logger.warn(
        `Rejected a CarryBee webhook: secret ${presented ? 'did not match' : 'header absent'}. Headers seen: ${Object.keys(req.headers).join(', ')}`,
      );
      throw new UnauthorizedException(
        presented
          ? 'The webhook secret does not match the one stored on this platform.'
          : 'No webhook secret header was sent. If this is CarryBee\'s registration check, open the registration window in the operator console (Couriers → CarryBee) and press "Add Webhook" again.',
      );
    }
    // CarryBee's integration check requires the secret echoed back verbatim.
    // Only ever sent to a caller that already proved it knows the value.
    res.setHeader(CB_HEADER, expected);

    // The registration handshake is an ordinary event by name, carrying
    // nothing else. Answering it is the whole contract.
    if (isHandshake) {
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
