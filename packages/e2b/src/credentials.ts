/**
 * E2B credentials — hand-written.
 *
 * The `Credentials` service resolves `{ apiKey, apiBaseUrl, domain }` per
 * request; the control-plane protocol sends the key as `X-API-Key` (the
 * same header the official SDK uses). `domain` also seeds the envd URL for
 * sandboxes whose API response doesn't carry one explicitly.
 */
import * as EffectConfig from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { ConfigError } from "@rikalabs/distilled-core/errors";

/**
 * The hosted E2B domain. The control plane lives at `api.<domain>`; sandbox
 * envd traffic goes through `sandbox.<domain>` (or `49983-<id>.<domain>`
 * direct-connect on self-hosted domains — see src/envd.ts).
 */
export const DEFAULT_DOMAIN = "e2b.dev";

export interface Config {
  readonly apiKey: Redacted.Redacted<string>;
  readonly apiBaseUrl: string;
  readonly domain: string;
}

export class Credentials extends Context.Service<
  Credentials,
  Effect.Effect<Config>
>()("E2BCredentials") {}

const envConfig = EffectConfig.all({
  apiKey: EffectConfig.schema(Schema.String, "E2B_API_KEY"),
  domain: EffectConfig.schema(Schema.String, "E2B_DOMAIN").pipe(
    EffectConfig.withDefault(DEFAULT_DOMAIN),
  ),
  apiUrl: EffectConfig.schema(Schema.String, "E2B_API_URL").pipe(
    EffectConfig.option,
  ),
});

export const CredentialsFromEnv = Layer.succeed(
  Credentials,
  envConfig.pipe(
    Effect.mapError(
      () =>
        new ConfigError({
          message: "E2B_API_KEY environment variable is required",
        }),
    ),
    Effect.map(({ apiKey, domain, apiUrl }) => ({
      apiKey: Redacted.make(apiKey),
      // Explicit E2B_API_URL wins; otherwise derive `api.<domain>` the way
      // the official SDK does.
      apiBaseUrl:
        apiUrl._tag === "Some" ? apiUrl.value : `https://api.${domain}`,
      domain,
    })),
    Effect.orDie,
  ),
);

/** Convenience layer from an API key + optional domain / control-plane URL. */
export const credentials = (config: {
  readonly apiKey: string;
  readonly domain?: string;
  readonly apiUrl?: string;
}): Layer.Layer<Credentials> =>
  Layer.succeed(
    Credentials,
    Effect.succeed({
      apiKey: Redacted.make(config.apiKey),
      apiBaseUrl:
        config.apiUrl ?? `https://api.${config.domain ?? DEFAULT_DOMAIN}`,
      domain: config.domain ?? DEFAULT_DOMAIN,
    }),
  );
