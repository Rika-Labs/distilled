import { Config, Context, Effect, Layer, Redacted } from "effect";

export interface Options {
  readonly apiKey: Redacted.Redacted<string>;
  readonly apiBaseUrl: string;
}

export class Credentials extends Context.Service<Credentials, Options>()(
  "TypeSafeCredentials",
) {}

export const credentials = (options: Options) =>
  Layer.succeed(Credentials, options);

export const CredentialsFromEnv = Layer.effect(
  Credentials,
  Effect.gen(function* () {
    return {
      apiKey: yield* Config.Redacted("TYPESAFE_API_KEY"),
      apiBaseUrl: yield* Config.String("TYPESAFE_API_URL").pipe(
        Config.withDefault("https://api.typesafe.ai/v1"),
      ),
    };
  }),
);
