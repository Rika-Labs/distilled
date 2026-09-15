/**
 * Cloudflare Sandbox bridge credentials — hand-written.
 *
 * The `Credentials` service resolves `{ apiKey, apiBaseUrl }` per request;
 * the protocol layer sends the key as `Authorization: Bearer <key>` (the
 * `SANDBOX_API_KEY` secret the bridge worker is deployed with). The API key
 * is OPTIONAL: a bridge deployed without `SANDBOX_API_KEY` accepts
 * unauthenticated requests — omitting it sends no Authorization header.
 *
 * `apiBaseUrl` is the URL of the deployed `@cloudflare/sandbox` `bridge()`
 * worker — e.g. `https://my-sandbox-bridge.<account>.workers.dev` — NOT the
 * Cloudflare platform API. There is no default: every deployment is
 * user-owned infrastructure.
 */
import * as EffectConfig from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { ConfigError } from "@rikalabs/distilled-core/errors";

export interface Config {
  /** `SANDBOX_API_KEY` bearer token; absent when the bridge is unauthenticated. */
  readonly apiKey: Redacted.Redacted<string> | undefined;
  /** Base URL of the deployed bridge worker (no trailing slash enforced). */
  readonly apiBaseUrl: string;
}

export class Credentials extends Context.Service<
  Credentials,
  Effect.Effect<Config, ConfigError>
>()("CloudflareSandboxCredentials") {}

const envConfig = EffectConfig.all({
  apiKey: EffectConfig.schema(Schema.String, "CLOUDFLARE_SANDBOX_API_KEY").pipe(
    EffectConfig.option,
  ),
  apiBaseUrl: EffectConfig.schema(Schema.String, "CLOUDFLARE_BRIDGE_URL").pipe(
    EffectConfig.orElse(() =>
      EffectConfig.schema(Schema.String, "SANDBOX_BRIDGE_URL"),
    ),
  ),
});

export const CredentialsFromEnv: Layer.Layer<Credentials> = Layer.succeed(
  Credentials,
  envConfig.pipe(
    Effect.mapError(
      () =>
        new ConfigError({
          message:
            "CLOUDFLARE_BRIDGE_URL environment variable is required (URL of the deployed @cloudflare/sandbox bridge worker)",
        }),
    ),
    Effect.map(({ apiKey, apiBaseUrl }) => ({
      apiKey: Option.isSome(apiKey) ? Redacted.make(apiKey.value) : undefined,
      apiBaseUrl,
    })),
  ),
);

/** Convenience layer from a bridge URL + optional API key. */
export const credentials = (config: {
  readonly apiBaseUrl: string;
  readonly apiKey?: string | Redacted.Redacted<string> | undefined;
}): Layer.Layer<Credentials> =>
  Layer.succeed(
    Credentials,
    Effect.succeed({
      apiKey:
        config.apiKey === undefined
          ? undefined
          : Redacted.isRedacted(config.apiKey)
            ? config.apiKey
            : Redacted.make(config.apiKey),
      apiBaseUrl: config.apiBaseUrl,
    }),
  );
