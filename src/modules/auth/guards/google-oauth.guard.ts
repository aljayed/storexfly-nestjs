import {
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthGuard } from '@nestjs/passport';

/**
 * Wraps the Google passport guard but returns 503 when OAuth credentials are
 * not configured, instead of attempting a doomed redirect to Google.
 */
@Injectable()
export class GoogleOAuthGuard extends AuthGuard('google') {
  constructor(private readonly config: ConfigService) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const enabled = Boolean(
      this.config.get<string>('google.clientId') &&
        this.config.get<string>('google.clientSecret'),
    );
    if (!enabled) {
      throw new ServiceUnavailableException(
        'Google sign-in is not configured on this server',
      );
    }
    return super.canActivate(context);
  }
}
