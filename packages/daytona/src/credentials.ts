/**
 * Daytona credentials — hand-written.
 *
 * The `Credentials` service resolves `{ apiKey, apiBaseUrl, organizationId? }`
 * per request; the protocol layer sends the key as `Authorization: Bearer`
 * and the organization as `X-Daytona-Organization-ID` (the same headers the
 * official `@daytonaio/sdk` sends).
 */
import * as EffectConfig from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { ConfigError } from "@rikalabs/distilled-core/errors";

/**
 * Daytona production control-plane URL (the official SDK's default).
 *
 * Override with `DAYTONA_API_URL` (the spelling the current SDK uses) or the
 * deprecated `DAYTONA_SERVER_URL`.
 */
export const DEFAULT_API_BASE_URL = "https://app.daytona.io/api";

export interface Config {
  readonly apiKey: Redacted.Redacted<string>;
  readonly apiBaseUrl: string;
  /**
   * Organization scoping. The official SDK only sends
   * `X-Daytona-Organization-ID` for JWT-authenticated clients; for API-key
   * auth it is derived server-side. Sent here when explicitly configured.
   */
  readonly organizationId?: string | undefined;
}

export class Credentials extends Context.Service<
  Credentials,
  Effect.Effect<Config>
>()("DaytonaCredentials") {}

const envConfig = EffectConfig.all({
  apiKey: EffectConfig.schema(Schema.String, "DAYTONA_API_KEY"),
  apiBaseUrl: EffectConfig.schema(Schema.String, "DAYTONA_API_URL").pipe(
    EffectConfig.orElse(() =>
      EffectConfig.schema(Schema.String, "DAYTONA_SERVER_URL").pipe(
        EffectConfig.withDefault(DEFAULT_API_BASE_URL),
      ),
    ),
  ),
  organizationId: EffectConfig.schema(
    Schema.String,
    "DAYTONA_ORGANIZATION_ID",
  ).pipe(EffectConfig.option),
});

export const CredentialsFromEnv = Layer.succeed(
  Credentials,
  envConfig.pipe(
    Effect.mapError(
      () =>
        new ConfigError({
          message: "DAYTONA_API_KEY environment variable is required",
        }),
    ),
    Effect.map(({ apiKey, apiBaseUrl, organizationId }) => ({
      apiKey: Redacted.make(apiKey),
      apiBaseUrl,
      ...(organizationId._tag === "Some"
        ? { organizationId: organizationId.value }
        : {}),
    })),
    Effect.orDie,
  ),
);

/** Convenience layer from an API key + optional base URL / organization. */
export const credentials = (config: {
  readonly apiKey: string;
  readonly apiBaseUrl?: string;
  readonly organizationId?: string;
}): Layer.Layer<Credentials> =>
  Layer.succeed(
    Credentials,
    Effect.succeed({
      apiKey: Redacted.make(config.apiKey),
      apiBaseUrl: config.apiBaseUrl ?? DEFAULT_API_BASE_URL,
      organizationId: config.organizationId,
    }),
  );
