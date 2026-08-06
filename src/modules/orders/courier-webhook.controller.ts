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

/**
 * CarryBee delivery callbacks - the channel that actually moves an order past
 * 'HandedOver'. Public by necessity (CarryBee calls it unauthenticated) and
 * guarded by the shared secret the operator configures alongside the
 * credentials: without a stored secret nothing is accepted at all, so a
 * half-configured integration fails closed rather than trusting the internet.
 *
 * CarryBee requires the endpoint to echo the secret back and to answer 202 on
 * the integration handshake, so both are done here. Every other outcome is
 * also a 202: a non-2xx makes CarryBee retry, and an event about a parcel we
 * have no order for will never succeed no matter how often it is redelivered.
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
    const expected = await this.courierSettings.carrybeeWebhookSecret();
    if (!expected || !matches(expected, presented)) {
      this.logger.warn(
        `Rejected a CarryBee webhook with a ${expected ? 'bad' : 'unconfigured'} secret`,
      );
      throw new UnauthorizedException('Invalid webhook secret');
    }
    // CarryBee's integration check requires the secret echoed back verbatim.
    // Only ever sent to a caller that already proved it knows the value.
    res.setHeader(CB_HEADER, expected);
    // The handshake carries the header but no event - a 202 with the echo is
    // the whole contract.
    if (!body?.event) {
      return { error: false, message: 'Webhook verified' };
    }
    try {
      const handled = await this.orders.applyCourierEvent(body);
      if (!handled) {
        this.logger.warn(
          `CarryBee event ${body.event} for consignment ${body.consignment_id ?? '?'} matched no order`,
        );
      }
    } catch (err) {
      // Swallowed on purpose: a retry storm from CarryBee would not fix a bug
      // on our side, and the event is recoverable from the seller's manual
      // refresh, which reads the same state from the same API.
      this.logger.error(
        `Failed to apply CarryBee event ${body.event}`,
        err as Error,
      );
    }
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
