/**
 * Daytona-specific error types.
 *
 * Re-exports the common HTTP errors from core and adds the Daytona-specific
 * unknown-error wrapper.
 */
export {
  BadGateway,
  BadRequest,
  Conflict,
  ConfigError,
  Forbidden,
  GatewayTimeout,
  InternalServerError,
  Locked,
  NotFound,
  ServiceUnavailable,
  TooManyRequests,
  Unauthorized,
  UnprocessableEntity,
  HTTP_STATUS_MAP,
  DEFAULT_ERRORS,
  API_ERRORS,
} from "@rikalabs/distilled-core/errors";
import type { DefaultErrors as CoreDefaultErrors } from "@rikalabs/distilled-core/errors";

import * as Schema from "effect/Schema";
import * as Category from "@rikalabs/distilled-core/category";

/**
 * Unknown Daytona error — returned when a failed response's HTTP status has
 * no mapped error class. Carries the raw body for later cataloging.
 */
export class UnknownDaytonaError extends Schema.TaggedError<UnknownDaytonaError>()(
  "UnknownDaytonaError",
  {
    code: Schema.optional(Schema.String),
    message: Schema.optional(Schema.String),
    body: Schema.Unknown,
  },
).pipe(Category.withServerError) {}

/** Schema parse error wrapper. */
export class DaytonaParseError extends Schema.TaggedError<DaytonaParseError>()(
  "DaytonaParseError",
  {
    body: Schema.Unknown,
    cause: Schema.Unknown,
  },
).pipe(Category.withParseError) {}

/**
 * Errors any Daytona operation may surface in addition to the per-operation
 * typed status errors.
 */
export type ClientErrors = UnknownDaytonaError | DaytonaParseError;

/**
 * Default Daytona operation errors: the shared HTTP status errors from core
 * plus the client-level fallback/decode errors.
 */
export type DefaultErrors = CoreDefaultErrors | ClientErrors;
