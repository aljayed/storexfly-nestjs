import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';

/**
 * The two Google routes are entered by a full-page browser navigation, so a
 * JSON error body is a dead end for the user. Turn every failure into a
 * redirect back to the Vue sign-in form with an `?error=` marker it can render:
 *  - credentials not configured (503 from `GoogleOAuthGuard`) → `google_disabled`
 *  - user cancelled, or Google rejected the exchange (401)     → `google`
 */
@Catch()
export class GoogleOAuthFailureFilter implements ExceptionFilter {
  constructor(private readonly config: ConfigService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    // The callback handler may have already redirected before failing.
    if (res.headersSent) return;

    const reason =
      exception instanceof ServiceUnavailableException
        ? 'google_disabled'
        : 'google';
    const base = this.config.getOrThrow<string>('google.successRedirect');
    const url = new URL('/sign-in', base);
    url.searchParams.set('error', reason);
    res.redirect(url.toString());
  }
}
