import { HttpStatus } from '@nestjs/common';

/** Postgres error codes we map to specific HTTP responses. */
const PG_UNIQUE_VIOLATION = '23505';
const PG_FOREIGN_KEY_VIOLATION = '23503';
const PG_NOT_NULL_VIOLATION = '23502';

interface MappedError {
  status: number;
  error: string;
  message: string;
}

function isPostgresError(e: unknown): e is { code: string; detail?: string } {
  return (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    typeof (e as { code: unknown }).code === 'string'
  );
}

/**
 * Translates a postgres-js driver error into an HTTP response shape. Returns
 * null for anything we don't specifically handle (the caller falls back to a
 * generic 500).
 */
export function postgresErrorToHttp(exception: unknown): MappedError | null {
  if (!isPostgresError(exception)) {
    return null;
  }
  switch (exception.code) {
    case PG_UNIQUE_VIOLATION:
      return {
        status: HttpStatus.CONFLICT,
        error: 'Conflict',
        message: 'A record with these details already exists',
      };
    case PG_FOREIGN_KEY_VIOLATION:
      return {
        status: HttpStatus.BAD_REQUEST,
        error: 'Bad Request',
        message: 'Referenced record does not exist',
      };
    case PG_NOT_NULL_VIOLATION:
      return {
        status: HttpStatus.BAD_REQUEST,
        error: 'Bad Request',
        message: 'A required field is missing',
      };
    default:
      return null;
  }
}
