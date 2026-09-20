import { Effect, Schema } from "effect";
import * as API from "@rikalabs/distilled-core/api";
import { API_ERRORS } from "@rikalabs/distilled-core/errors";
import { Http } from "@rikalabs/distilled-core/trait";
import type { HttpClient } from "effect/unstable/http";
import { Credentials } from "./credentials.ts";
import { TypeSafeProtocol, UnknownTypeSafeError } from "./protocol.ts";
import {
  ListModelsResponse,
  SystemOneRequest,
  SystemOneResponse,
} from "./schema.ts";

export * from "./credentials.ts";
export * from "./schema.ts";
export * from "./protocol.ts";

// These two documented operations are hand-maintained, not generated.
// No automatic retries: each evaluation may incur token usage.
const evaluate = API.make(() => ({
  input: SystemOneRequest.pipe(
    Http({ method: "POST", uri: "/systemone", code: 200 }),
  ),
  output: SystemOneResponse,
  errors: [...API_ERRORS, UnknownTypeSafeError],
  protocol: TypeSafeProtocol,
}));
const models = API.make(() => ({
  input: Schema.Struct({}).pipe(
    Http({ method: "GET", uri: "/models", code: 200 }),
  ),
  output: ListModelsResponse,
  errors: [...API_ERRORS, UnknownTypeSafeError],
  protocol: TypeSafeProtocol,
}));

export type TypeSafeError =
  | Effect.Error<ReturnType<typeof evaluate>>
  | Schema.SchemaError;
export type TypeSafeContext = Credentials | HttpClient.HttpClient;

export const systemOne = Effect.fnUntraced(function* (
  request: typeof SystemOneRequest.Type,
): Effect.fn.Return<
  typeof SystemOneResponse.Type,
  TypeSafeError,
  TypeSafeContext
> {
  const input = yield* Schema.decodeUnknownEffect(SystemOneRequest)(request);
  return yield* Schema.decodeUnknownEffect(SystemOneResponse)(
    yield* evaluate(input),
  );
});
export const listModels = Effect.fnUntraced(function* (): Effect.fn.Return<
  typeof ListModelsResponse.Type,
  TypeSafeError,
  TypeSafeContext
> {
  return yield* Schema.decodeUnknownEffect(ListModelsResponse)(
    yield* models({}),
  );
});
