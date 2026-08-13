import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface SmsCfg {
  baseUrl: string;
  apiKey: string;
  userName: string;
  senderName: string;
  timeoutMs: number;
  enabled: boolean;
}

/**
 * MiMSMS answers every request with HTTP 200 and puts the real verdict in the
 * body, so the status line says nothing - `statusCode`/`status` are what
 * decide, and `responseResult` carries the human reason ("Invalid API Key",
 * "Insufficient Balance", "IP Black List", …).
 *
 * `error_Data[].errorParm` names whatever the gateway objected to, which is the
 * one field worth reading closely: on a rejected IP it is the address that has
 * to be whitelisted in the MiMSMS panel, and nothing else in the response says
 * so. Both of these go in the log because an operator cannot fix a failure they
 * cannot see the reason for.
 */
interface MimSmsResponse {
  statusCode?: string;
  status?: string;
  trxnId?: string;
  responseResult?: string;
  error_Data?: {
    res_Code?: string;
    error?: string;
    failedNumbers?: string;
    errorParm?: string;
  }[];
}

/**
 * Outbound SMS through MiMSMS (api.mimsms.com). Only transactional messages
 * are sent - type `T`, one recipient per request - because everything the
 * platform texts is an OTP, and transactional traffic is delivered regardless
 * of the recipient's DND status.
 *
 * Mirrors {@link MailService}: with credentials unset the gateway is left off
 * and messages are logged in non-production instead of sent, so the phone
 * verification flows stay testable without an account. Configure SMS_* to send
 * for real.
 */
@Injectable()
export class SmsService implements OnModuleInit {
  private readonly logger = new Logger(SmsService.name);
  private cfg!: SmsCfg;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    this.cfg = this.config.getOrThrow<SmsCfg>('sms');
    if (!this.cfg.enabled) {
      this.logger.warn(
        'SMS_* not configured - text messages will be logged, not sent.',
      );
    }
  }

  /** True once a real gateway is behind {@link send}. */
  get enabled(): boolean {
    return this.cfg.enabled;
  }

  /**
   * Texts `message` to one number. Throws when the gateway rejects it, so a
   * caller that just minted an OTP can tell the user it did not go out rather
   * than leaving them waiting for an SMS that will never arrive.
   */
  async send(phone: string, message: string): Promise<void> {
    const mobileNumber = toMsisdn(phone);
    if (!mobileNumber) {
      throw new ServiceUnavailableException('That phone number is not valid.');
    }

    if (!this.cfg.enabled) {
      // Reference behaviour without a gateway, same as MailService: surface the
      // message in the log so the flow can be exercised locally.
      if (process.env.NODE_ENV !== 'production') {
        this.logger.debug(`[sms:not-sent] to=${mobileNumber}\n${message}`);
      }
      return;
    }

    let res: Response;
    try {
      res = await fetch(`${this.cfg.baseUrl}/V2/SMS`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: this.cfg.apiKey,
          userName: this.cfg.userName,
          senderName: this.cfg.senderName,
          transactionType: 'T',
          mobileNumber,
          message,
        }),
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
    } catch (err: unknown) {
      // Network trouble or the timeout above - never the recipient's fault.
      this.logger.error(
        `SMS gateway unreachable for ${mobileNumber}: ${String(err)}`,
      );
      throw new ServiceUnavailableException(
        'Could not send the code right now. Please try again.',
      );
    }

    const body = (await res.json().catch(() => ({}))) as MimSmsResponse;
    if (!res.ok || !accepted(body)) {
      // The credentials are in this request; only the verdict goes in the log.
      const detail = (body.error_Data ?? [])
        .map((e) => [e.error, e.errorParm].filter(Boolean).join(' '))
        .filter(Boolean)
        .join('; ');
      this.logger.error(
        `SMS to ${mobileNumber} rejected (http=${res.status} status=${
          body.status ?? '?'
        } code=${body.statusCode ?? '?'}): ${
          body.responseResult ?? 'no reason given'
        }${detail ? ` - ${detail}` : ''}`,
      );
      throw new ServiceUnavailableException(
        'Could not send the code right now. Please try again.',
      );
    }

    this.logger.log(`SMS sent to ${mobileNumber} (trxn=${body.trxnId ?? '-'})`);
  }
}

/** True when MiMSMS took the message. */
function accepted(body: MimSmsResponse): boolean {
  return (
    body.statusCode === '200' || body.status?.toLowerCase().trim() === 'success'
  );
}

/**
 * The gateway wants a Bangladeshi MSISDN - `8801XXXXXXXXX`, no `+`. Phones
 * reach here in whichever shape their flow uses (`+8801…` from the create-shop
 * wizard, the bare national number from checkout), so reduce every one of them
 * to digits and put the single country code back on.
 */
export function toMsisdn(raw: string | null | undefined): string {
  const national = (raw ?? '')
    .replace(/\D/g, '')
    .replace(/^880/, '')
    .replace(/^0+/, '');
  return national ? `880${national}` : '';
}
