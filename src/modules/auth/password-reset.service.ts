import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { MailService } from '../mail/mail.service';
import { UsersService } from '../users/users.service';

const BCRYPT_ROUNDS = 12;

interface ResetEntry {
  userId: string;
  expiresAt: number;
}

/**
 * Forgot/reset password for seller (email) accounts. The issued token is mailed
 * as a link to the Vue app; verifying it lets the user set a new password.
 *
 * Like {@link OtpService} this keeps tokens in memory - a reference store that
 * should be swapped for Redis (or a DB table) in production so links survive a
 * restart and scale across instances.
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);
  private readonly store = new Map<string, ResetEntry>();
  private readonly ttlMs = 30 * 60 * 1000;

  constructor(
    private readonly users: UsersService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Issue a reset link for the email if it maps to a password account. Always
   * resolves the same way regardless of whether the account exists, so callers
   * can't probe which emails are registered.
   */
  async request(email: string): Promise<void> {
    const user = await this.users.findByEmail(email);
    // Only email/password accounts can reset a password - social/phone-only
    // accounts (no passwordHash) have nothing to reset.
    if (!user || !user.passwordHash || !user.email) {
      return;
    }

    const token = randomBytes(32).toString('hex');
    this.store.set(token, {
      userId: user.id,
      expiresAt: Date.now() + this.ttlMs,
    });

    const webUrl = this.config.getOrThrow<string>('app.webUrl');
    const resetUrl = `${webUrl.replace(/\/$/, '')}/reset-password?token=${token}`;

    await this.mail.send({
      to: user.email,
      subject: 'Reset your Storexfly password',
      text: this.textBody(user.name, resetUrl),
      html: this.htmlBody(user.name, resetUrl),
    });
  }

  /** Consume a token and set the new password. Single-use; throws if invalid. */
  async reset(token: string, newPassword: string): Promise<void> {
    const entry = this.store.get(token);
    if (!entry || Date.now() > entry.expiresAt) {
      this.store.delete(token);
      throw new BadRequestException(
        'This reset link is invalid or has expired',
      );
    }
    this.store.delete(token);

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await this.users.updatePassword(entry.userId, passwordHash);
  }

  private textBody(name: string, url: string): string {
    return [
      `Hi ${name},`,
      '',
      'We received a request to reset your Storexfly password.',
      'Open the link below to choose a new one (it expires in 30 minutes):',
      '',
      url,
      '',
      "If you didn't request this, you can safely ignore this email.",
    ].join('\n');
  }

  private htmlBody(name: string, url: string): string {
    return `
      <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;color:#1a1814">
        <h2 style="font-weight:800">Reset your password</h2>
        <p>Hi ${escapeHtml(name)},</p>
        <p>We received a request to reset your Storexfly password. Click the
           button below to choose a new one. This link expires in 30 minutes.</p>
        <p style="margin:28px 0">
          <a href="${url}"
             style="background:#1a1814;color:#fff;text-decoration:none;
                    padding:12px 22px;border-radius:10px;font-weight:700;display:inline-block">
            Reset password
          </a>
        </p>
        <p style="color:#87827a;font-size:13px">
          If you didn't request this, you can safely ignore this email.
        </p>
      </div>
    `;
  }
}

/** The display name is user-supplied - never interpolate it into HTML raw. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
