/**
 * Cloudflare Sandbox-specific error types.
 *
 * Re-exports the common HTTP errors from core and adds the bridge-specific
 * unknown-error wrapper plus a dedicated 404 class for the tunnel-delete
 * operation (the OpenAPI spec declares no named error schemas — status is
 * the only discriminator the wire gives us).
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
import { applyErrorMatchers } from "@rikalabs/distilled-core/trait";

/**
 * Unknown Cloudflare Sandbox bridge error — returned when a failed
 * response's HTTP status has no mapped error class. Carries the raw body
 * for later cataloging (bridge error bodies are `{error, code}` JSON).
 */
export class UnknownCloudflareSandboxError extends Schema.TaggedError<UnknownCloudflareSandboxError>()(
  "UnknownCloudflareSandboxError",
  {
    code: Schema.optional(Schema.String),
    message: Schema.optional(Schema.String),
    body: Schema.Unknown,
  },
).pipe(Category.withServerError) {}

/** Schema parse error wrapper. */
export class CloudflareSandboxParseError extends Schema.TaggedError<CloudflareSandboxParseError>()(
  "CloudflareSandboxParseError",
  {
    body: Schema.Unknown,
    cause: Schema.Unknown,
  },
).pipe(Category.withParseError) {}

/** DELETE tunnel returned 404 — the port had no live tunnel. */
export class TunnelNotFound extends Schema.TaggedError<TunnelNotFound>()(
  "TunnelNotFound",
  {
    code: Schema.optional(Schema.Number),
    message: Schema.optional(Schema.String),
  },
).pipe(Category.withNotFoundError) {}
applyErrorMatchers(TunnelNotFound, [{ status: 404 }]);

/**
 * Errors any Cloudflare Sandbox operation may surface in addition to the
 * per-operation typed status errors.
 */
export type ClientErrors =
  | UnknownCloudflareSandboxError
  | CloudflareSandboxParseError;

/**
 * Default Cloudflare Sandbox operation errors: the shared HTTP status
 * errors from core plus the client-level fallback/decode errors.
 */
export type DefaultErrors = CoreDefaultErrors | ClientErrors;
