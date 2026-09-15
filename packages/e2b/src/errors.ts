/**
 * E2B-specific error types.
 *
 * Re-exports the common HTTP errors from core and adds the E2B-specific
 * unknown-error wrapper. E2B's error envelope is
 * `{ code: number, error_code?: string, message: string }` — the semantic
 * `error_code` (e.g. `sandbox_capacity_unavailable`) is preserved on
 * `UnknownE2BError.code` when present.
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
 * Unknown E2B error — returned when a failed response's HTTP status has no
 * mapped error class, and for Connect-RPC error frames (`connect+json`
 * end-stream errors carry `{code, message}`). Carries the raw body for
 * later cataloging.
 */
export class UnknownE2BError extends Schema.TaggedError<UnknownE2BError>()(
  "UnknownE2BError",
  {
    code: Schema.optional(Schema.String),
    message: Schema.optional(Schema.String),
    body: Schema.Unknown,
  },
).pipe(Category.withServerError) {}

/** Schema parse error wrapper. */
export class E2BParseError extends Schema.TaggedError<E2BParseError>()(
  "E2BParseError",
  {
    body: Schema.Unknown,
    cause: Schema.Unknown,
  },
).pipe(Category.withParseError) {}

/**
 * Errors any E2B operation may surface in addition to the per-operation
 * typed status errors.
 */
export type ClientErrors = UnknownE2BError | E2BParseError;

/**
 * Default E2B operation errors: the shared HTTP status errors from core
 * plus the client-level fallback/decode errors.
 */
export type DefaultErrors = CoreDefaultErrors | ClientErrors;
