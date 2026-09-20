import { Effect, Redacted, Schema } from "effect";
import { makeRestProtocol } from "@rikalabs/distilled-core/protocol-rest";
import { Credentials } from "./credentials.ts";

export class UnknownTypeSafeError extends Schema.TaggedError<UnknownTypeSafeError>()(
  "UnknownTypeSafeError",
  {
    message: Schema.String,
    status: Schema.Number,
  },
) {}

export const TypeSafeProtocol = makeRestProtocol({
  credentials: Effect.service(Credentials),
  baseUrl: (credentials) => credentials.apiBaseUrl.replace(/\/+$/, ""),
  headers: (credentials) => ({
    Authorization: `Bearer ${Redacted.value(credentials.apiKey)}`,
  }),
  unknownError: ({ status }) =>
    new UnknownTypeSafeError({ status, message: `TypeSafe HTTP ${status}` }),
});
