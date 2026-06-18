import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

/**
 * Thin wrapper around a nodemailer SMTP transport. When SMTP isn't configured
 * (no host/user/pass) the transport is left null and messages are logged in
 * non-production instead of sent — so flows like password reset are testable
 * without a real gateway. Configure MAIL_* env vars to send for real.
 */
@Injectable()
export class MailService implements OnModuleInit {
  private readonly logger = new Logger(MailService.name);
  private transporter: Transporter | null = null;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const mail = this.config.getOrThrow<{
      host: string;
      port: number;
      secure: boolean;
      user: string;
      pass: string;
    }>('mail');

    if (!(mail.host && mail.user && mail.pass)) {
      this.logger.warn(
        'MAIL_* not configured — emails will be logged, not sent.',
      );
      return;
    }

    this.transporter = nodemailer.createTransport({
      host: mail.host,
      port: mail.port,
      secure: mail.secure,
      auth: { user: mail.user, pass: mail.pass },
    });
  }

  async send(options: {
    to: string;
    subject: string;
    html: string;
    text: string;
  }): Promise<void> {
    const from = this.config.getOrThrow<string>('mail.from');

    if (!this.transporter) {
      // Reference behaviour without a gateway: surface the message in the log
      // so the flow can be exercised locally.
      if (process.env.NODE_ENV !== 'production') {
        this.logger.debug(
          `[email:not-sent] to=${options.to} subject="${options.subject}"\n${options.text}`,
        );
      }
      return;
    }

    await this.transporter.sendMail({
      from,
      to: options.to,
      subject: options.subject,
      text: options.text,
      html: options.html,
    });
  }
}
