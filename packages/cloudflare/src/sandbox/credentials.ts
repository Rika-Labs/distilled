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
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { ConfigError } from "@rikalabs/distilled-core/errors";
import { envVar } from "@rikalabs/distilled-core/env";

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

const envConfig: Effect.Effect<
  { apiKey: string | undefined; apiBaseUrl: string },
  ConfigError
> = Effect.suspend(() => {
  const apiBaseUrl =
    envVar("CLOUDFLARE_BRIDGE_URL") ?? envVar("SANDBOX_BRIDGE_URL");
  if (apiBaseUrl === undefined) {
    return Effect.fail(
      new ConfigError({
        message:
          "CLOUDFLARE_BRIDGE_URL environment variable is required (URL of the deployed @cloudflare/sandbox bridge worker)",
      }),
    );
  }
  return Effect.succeed({
    apiKey: envVar("CLOUDFLARE_SANDBOX_API_KEY"),
    apiBaseUrl,
  });
});

export const CredentialsFromEnv: Layer.Layer<Credentials> = Layer.succeed(
  Credentials,
  envConfig.pipe(
    Effect.map(({ apiKey, apiBaseUrl }) => ({
      apiKey: apiKey === undefined ? undefined : Redacted.make(apiKey),
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
