/**
 * ModalProtocol — unary binary gRPC (`application/grpc`).
 *
 * Each generated operation is `POST /<package>.<Service>/<Method>` with a
 * framed protobuf body (1-byte compression flag, 4-byte big-endian length,
 * message bytes) encoded by `core/protobuf` from the `T.ProtoField` member
 * annotations the converter emits.
 *
 * Auth is Modal's two-step exchange: `x-modal-token-id` /
 * `x-modal-token-secret` bootstrap `ModalClient/AuthTokenGet`, and every
 * other call carries the returned short-lived token as
 * `x-modal-auth-token`. The token is a JWT; it is cached per credentials
 * until ~55% through its observed lifetime (the official client's refresh
 * fraction), with a 300s fallback when the token carries no `exp` claim.
 * Token refetches are not guarded by a mutex — a concurrent stampede just
 * issues a couple of extra `AuthTokenGet` calls.
 *
 * Direct use of the gRPC API is unsupported by Modal and may change
 * without notice.
 */
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as S from "effect/Schema";
import * as Encoding from "effect/Encoding";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientError from "effect/unstable/http/HttpClientError";
import type * as API from "@rikalabs/distilled-core/api";
import type { ConfigError } from "@rikalabs/distilled-core/errors";
import {
  grpcFrame,
  makeGrpcProtocol,
  readMessageFrame,
  type GrpcErrorInfo,
} from "@rikalabs/distilled-core/protocol-grpc";
import { decodeMessage } from "@rikalabs/distilled-core/protobuf";
import { ProtoField } from "@rikalabs/distilled-core/trait";
import { Credentials, type Config } from "./credentials.ts";
import { UnknownModalError, type DefaultErrors } from "./errors.ts";

/**
 * Behaves like this Python SDK version, matching the official JS client's
 * `x-modal-client-version` pin.
 */
export const CLIENT_VERSION = "1.0.0";

/** `CLIENT_TYPE_LIBMODAL_JS` in modal_proto. */
export const CLIENT_TYPE_LIBMODAL_JS = "8";

/**
 * Error channel shared by every generated Modal operation. Generated service
 * files annotate operations with `API.OperationMethod<I, O, ModalOpError,
 * ModalOpContext>` explicitly so the compiler never infers these back out of
 * the schema generics.
 */
export type ModalOpError =
  | DefaultErrors
  | ConfigError
  | HttpClientError.HttpClientError;

/** Context (requirements) shared by every generated Modal operation. */
export type ModalOpContext = Credentials | HttpClient.HttpClient;

const AUTH_TOKEN_GET_PATH = "/modal.client.ModalClient/AuthTokenGet";

/** `AuthTokenGetResponse { string token = 1 }`. */
const AuthTokenGetResponse = S.Struct({
  token: S.optional(S.String.pipe(ProtoField({ n: 1, t: "string" }))),
});

interface CachedToken {
  readonly token: string;
  /** Unix seconds after which the token is refetched. */
  readonly refreshAt: number;
}

/**
 * Tokens are cached per (base URL, token id) so context-provided
 * credentials pick up a fresh entry automatically.
 */
const tokenCache = new Map<string, CachedToken>();

/** Decode the JWT `exp` claim (seconds); 0 when absent or unparsable. */
const jwtExpiry = (token: string): number => {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[1] === undefined) return 0;
  const decoded = Encoding.decodeBase64UrlString(parts[1]);
  if (decoded._tag !== "Success") return 0;
  try {
    const claims: unknown = JSON.parse(decoded.success);
    const exp =
      typeof claims === "object" && claims !== null
        ? (claims as Record<string, unknown>).exp
        : undefined;
    return typeof exp === "number" ? exp : 0;
  } catch {
    return 0;
  }
};

const fetchAuthToken = (
  creds: Config,
): Effect.Effect<
  string,
  UnknownModalError | HttpClientError.HttpClientError,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.post(`${creds.apiBaseUrl}${AUTH_TOKEN_GET_PATH}`).pipe(
        HttpClientRequest.bodyUint8Array(grpcFrame(new Uint8Array(0))),
        HttpClientRequest.setHeaders({
          "content-type": "application/grpc",
          accept: "application/grpc",
          te: "trailers",
          "x-modal-token-id": Redacted.value(creds.tokenId),
          "x-modal-token-secret": Redacted.value(creds.tokenSecret),
          "x-modal-client-type": CLIENT_TYPE_LIBMODAL_JS,
          "x-modal-client-version": CLIENT_VERSION,
        }),
      ),
    );
    const headers = response.headers as Record<string, string | undefined>;
    const grpcStatus = headers["grpc-status"];
    if (grpcStatus !== undefined && grpcStatus !== "0") {
      return yield* Effect.fail(
        new UnknownModalError({
          code: `grpc:${grpcStatus}`,
          message: "AuthTokenGet failed",
          body: undefined,
        }),
      );
    }
    const buf = new Uint8Array(yield* response.arrayBuffer.pipe(Effect.orDie));
    const payload = readMessageFrame(buf);
    const decoded =
      payload !== undefined
        ? decodeMessage(AuthTokenGetResponse.ast, payload)
        : {};
    const token = decoded.token;
    if (typeof token !== "string" || token === "") {
      return yield* Effect.fail(
        new UnknownModalError({
          message: "AuthTokenGet returned no token",
          body: undefined,
        }),
      );
    }
    return token;
  });

/**
 * Resolve (and cache) the short-lived `x-modal-auth-token` for `creds`.
 * Refresh timing follows the official client: a JWT `exp` claim drives the
 * lifetime, refreshed at ~55% through it; no claim → 300s default.
 */
const authTokenFor = (
  creds: Config,
): Effect.Effect<
  string,
  UnknownModalError | HttpClientError.HttpClientError,
  HttpClient.HttpClient
> => {
  const key = `${creds.apiBaseUrl}\n${Redacted.value(creds.tokenId)}`;
  const now = Math.floor(Date.now() / 1000);
  const cached = tokenCache.get(key);
  if (cached !== undefined && now < cached.refreshAt) {
    return Effect.succeed(cached.token);
  }
  return Effect.map(fetchAuthToken(creds), (token) => {
    const expiry = jwtExpiry(token);
    const fallback = now + 300;
    const exp = expiry > 0 ? expiry : fallback;
    const refreshAt = now + Math.max(1, Math.floor((exp - now) * 0.55));
    tokenCache.set(key, { token, refreshAt });
    return token;
  });
};

export const ModalProtocol: Layer.Layer<API.Protocol> =
  makeGrpcProtocol<Config>({
    credentials: Effect.gen(function* () {
      const resolve = yield* Credentials;
      return yield* resolve;
    }),
    baseUrl: (creds) => creds.apiBaseUrl,
    headers: () => ({
      "x-modal-client-type": CLIENT_TYPE_LIBMODAL_JS,
      "x-modal-client-version": CLIENT_VERSION,
      "x-modal-libmodal-version": "distilled-modal/1.0.0-rc.8",
    }),
    authenticate: ({ credentials: creds, path }) => {
      const bootstrap = {
        "x-modal-token-id": Redacted.value(creds.tokenId),
        "x-modal-token-secret": Redacted.value(creds.tokenSecret),
      };
      // Modal's server requires the token-id/secret pair on every call; the
      // auth-token JWT alone is only accepted on some read paths.
      return path === AUTH_TOKEN_GET_PATH
        ? Effect.succeed(bootstrap)
        : Effect.map(authTokenFor(creds), (token) => ({
            ...bootstrap,
            "x-modal-auth-token": token,
          }));
    },
    unknownError: ({
      grpcStatusName,
      grpcStatus,
      message,
      headers,
    }: GrpcErrorInfo) =>
      new UnknownModalError({
        code:
          grpcStatusName ??
          (grpcStatus !== undefined ? `grpc:${grpcStatus}` : undefined),
        message,
        body: { headers },
      }),
  });
