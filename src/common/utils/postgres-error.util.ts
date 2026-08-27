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

function isPostgresError(
  e: unknown,
): e is { code: string; detail?: string; constraint_name?: string } {
  return (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    typeof e.code === 'string'
  );
}

/**
 * Drizzle (≥0.44) wraps driver failures in a DrizzleQueryError whose `cause`
 * holds the original postgres-js error - walk the cause chain to find it.
 */
function unwrapPostgresError(
  e: unknown,
): { code: string; detail?: string; constraint_name?: string } | null {
  for (let depth = 0; e && depth < 5; depth++) {
    if (isPostgresError(e)) {
      return e;
    }
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

/** True when the error is a Postgres unique-constraint violation. */
export function isUniqueViolation(e: unknown): boolean {
  return unwrapPostgresError(e)?.code === PG_UNIQUE_VIOLATION;
}

/**
 * True when the error is a unique-constraint violation on one *particular*
 * index. A table with more than one unique index (shops has two - the handle
 * and the trade licence) needs to know which one refused the write, or the
 * caller ends up explaining the wrong problem to the user.
 *
 * `constraint_name` is what postgres-js reports; the detail string is checked
 * too, since a driver that omits the field still names the index there.
 */
export function isUniqueViolationOn(e: unknown, index: string): boolean {
  const pgError = unwrapPostgresError(e);
  if (pgError?.code !== PG_UNIQUE_VIOLATION) {
    return false;
  }
  return pgError.constraint_name === index || !!pgError.detail?.includes(index);
}

/**
 * Translates a postgres-js driver error into an HTTP response shape. Returns
 * null for anything we don't specifically handle (the caller falls back to a
 * generic 500).
 */
export function postgresErrorToHttp(exception: unknown): MappedError | null {
  const pgError = unwrapPostgresError(exception);
  if (!pgError) {
    return null;
  }
  switch (pgError.code) {
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
