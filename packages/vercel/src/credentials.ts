/**
 * Vercel credentials — hand-written.
 *
 * The `Credentials` service resolves `{ token, apiBaseUrl }` per request; the
 * protocol layer formats the `Authorization: Bearer <token>` header from it.
 * The token is a Vercel access token — personal, team, or an OAuth
 * integration's — the REST API accepts all of them as bearer tokens.
 *
 * Vercel scopes most requests to a team via the `teamId`/`slug` QUERY
 * parameters, which the spec declares per operation; they stay ordinary input
 * fields rather than credential state, because a single token routinely spans
 * several teams.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { ConfigError } from "@rikalabs/distilled-core/errors";
import { envVar } from "@rikalabs/distilled-core/env";

/** Vercel's REST API root. */
export const DEFAULT_API_BASE_URL = "https://api.vercel.com";

export interface Config {
  readonly token: Redacted.Redacted<string>;
  readonly apiBaseUrl: string;
}

export class Credentials extends Context.Service<
  Credentials,
  Effect.Effect<Config>
>()("VercelCredentials") {}

const envConfig: Effect.Effect<
  { token: string; apiBaseUrl: string },
  ConfigError
> = Effect.suspend(() => {
  const token = envVar("VERCEL_TOKEN");
  if (token === undefined) {
    return Effect.fail(
      new ConfigError({
        message: "VERCEL_TOKEN environment variable is required",
      }),
    );
  }
  return Effect.succeed({
    token,
    apiBaseUrl: envVar("VERCEL_API_URL") ?? DEFAULT_API_BASE_URL,
  });
});

export const CredentialsFromEnv = Layer.succeed(
  Credentials,
  envConfig.pipe(
    Effect.map(({ token, apiBaseUrl }) => ({
      token: Redacted.make(token),
      apiBaseUrl,
    })),
    Effect.orDie,
  ),
);

/** Convenience layer from a plain token + optional base URL. */
export const credentials = (config: {
  readonly token: string;
  readonly apiBaseUrl?: string;
}): Layer.Layer<Credentials> =>
  Layer.succeed(
    Credentials,
    Effect.succeed({
      token: Redacted.make(config.token),
      apiBaseUrl: config.apiBaseUrl ?? DEFAULT_API_BASE_URL,
    }),
  );
