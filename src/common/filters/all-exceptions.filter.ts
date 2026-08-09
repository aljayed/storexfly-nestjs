import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { postgresErrorToHttp } from '../utils/postgres-error.util';

interface ErrorBody {
  statusCode: number;
  error: string;
  message: string | string[];
  // Optional machine-readable code (e.g. 'PHONE_TAKEN') for clients that need
  // to branch on a specific failure rather than match on the message text.
  code?: string;
  // Seconds until the action that was refused can be retried - a countdown a
  // screen can show, rather than a button that keeps looking available.
  retryAfterSeconds?: number;
  path: string;
  timestamp: string;
}

/**
 * Catch-all exception filter producing a consistent JSON error envelope and
 * translating known Postgres driver errors (e.g. unique violations) into the
 * right HTTP status. Unknown errors are logged with a stack and surfaced as a
 * generic 500 so we never leak internals to clients.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = 'Internal server error';
    let error = 'Internal Server Error';
    let code: string | undefined;
    let retryAfterSeconds: number | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      if (typeof res === 'string') {
        message = res;
      } else if (typeof res === 'object' && res !== null) {
        const body = res as Record<string, unknown>;
        message = (body.message as string | string[]) ?? exception.message;
        error = (body.error as string) ?? exception.name;
        if (typeof body.code === 'string') code = body.code;
        if (typeof body.retryAfterSeconds === 'number') {
          retryAfterSeconds = body.retryAfterSeconds;
        }
      }
    } else {
      const mapped = postgresErrorToHttp(exception);
      if (mapped) {
        status = mapped.status;
        message = mapped.message;
        error = mapped.error;
      }
    }

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${request.method} ${request.url} -> ${status}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    const body: ErrorBody = {
      statusCode: status,
      error,
      message,
      ...(code ? { code } : {}),
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      path: request.url,
      timestamp: new Date().toISOString(),
    };

    response.status(status).json(body);
  }
}
