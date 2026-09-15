/**
 * E2B protocols — hand-written.
 *
 * Two `API.Protocol` layers back the generated services:
 *
 *   E2BProtocol      control plane (api.<domain>). Plain REST JSON over
 *                    `buildRequest`, `X-API-Key` auth, and E2B's shared
 *                    `{code, error_code?, message}` error envelope. Two
 *                    deviations from `makeRestProtocol` are why this is
 *                    hand-rolled rather than configured:
 *                      1. header-bound OUTPUT members — paginated list ops
 *                         carry `nextToken`/`totalRunning` on the wire as
 *                         response headers (X-Next-Token / X-Total-Running);
 *                         decode injects them into the output object so the
 *                         generic token paginator sees a normal member.
 *                      2. `T.QueryJoin` members — `explode: false` arrays
 *                         serialize comma-joined, which `buildRequest` has
 *                         no notion of; input is pre-joined here.
 *
 *   E2BEnvdProtocol  per-sandbox envd. All requests go to the `EnvdConnection`
 *                    resolved on the calling fiber (base URL + X-Access-Token
 *                    + sandbox routing headers — see src/envd.ts). Two wire
 *                    shapes share the layer, dispatched by the op's URI:
 *                      - `/envs`, `/files`, `/health`, `/metrics`,
 *                        `/files/compose` — envd REST (JSON; octet-stream for
 *                        the file download's `T.HttpBody` output and the
 *                        multipart upload's `T.FormDataFile` input).
 *                      - `/<package>.<Service>/<Method>` — Connect-RPC with
 *                        binary protobuf payloads driven by the `T.ProtoField`
 *                        member annotations. Unary calls send a raw
 *                        `application/proto` body; server-streaming calls
 *                        (`T.ConnectStream` inputs) send one
 *                        `application/connect+proto` envelope and decode the
 *                        5-byte-framed response stream, whose terminal `0x02`
 *                        frame carries an optional JSON `{error}`.
 *
 * Connect unary errors arrive as non-200 JSON `{code, message}`; the code is
 * mapped to its canonical HTTP status so the shared status map (and the
 * adapter's status-driven error semantics) applies unchanged.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import type * as AST from "effect/SchemaAST";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientError from "effect/unstable/http/HttpClientError";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as API from "@rikalabs/distilled-core/api";
import type { ConfigError } from "@rikalabs/distilled-core/errors";
import {
  HTTP_STATUS_MAP,
  InternalServerError,
} from "@rikalabs/distilled-core/errors";
import {
  buildRequest,
  getAnn,
  getPropAnn,
  getProps,
  hasPropAnn,
  mapKeys,
  matchTypedError,
  nameOf,
  resolveNode,
} from "@rikalabs/distilled-core/protocol-http";
import { wrapSensitive } from "@rikalabs/distilled-core/protocol-rest";
import {
  decodeMessage,
  encodeMessage,
} from "@rikalabs/distilled-core/protobuf";
import {
  headerSymbol,
  httpBodySymbol,
  httpSymbol,
  type HttpTrait,
} from "@rikalabs/distilled-core/trait";
import { debugHttp } from "@rikalabs/distilled-core/env";
import { parseRetryAfterForStatus } from "@rikalabs/distilled-core/retry-after";
import { Credentials, type Config } from "./credentials.ts";
import { EnvdConnection, type EnvdConnectionValue } from "./envd.ts";
import { UnknownE2BError, type DefaultErrors } from "./errors.ts";
import {
  connectStreamSymbol,
  queryJoinSymbol,
  rawResponseSymbol,
} from "./traits.ts";

/**
 * Error channel shared by every generated control-plane operation. Generated
 * service files annotate operations with `API.OperationMethod<I, O,
 * E2BOpError, E2BOpContext>` explicitly so the compiler never infers these
 * back out of the schema generics.
 */
export type E2BOpError =
  | DefaultErrors
  | ConfigError
  | HttpClientError.HttpClientError;

/** Context (requirements) shared by every generated control-plane operation. */
export type E2BOpContext = Credentials | HttpClient.HttpClient;

/**
 * Error channel / context shared by every generated envd operation. The
 * `EnvdConnection` requirement is what scopes a call to one sandbox — the
 * adapter provides it per sandbox handle.
 */
export type E2BEnvdOpError =
  | DefaultErrors
  | ConfigError
  | HttpClientError.HttpClientError;

export type E2BEnvdOpContext = EnvdConnection | HttpClient.HttpClient;

// =============================================================================
// Shared REST decode (both planes)
// =============================================================================

// Bridge: Protocol.decode is typed as Effect<unknown> (no error channel),
// but wire failures are real typed errors that operations re-surface via
// their `errors: [...]` lists. Same convention as protocol-rest's `fail`.
const fail = (e: unknown): Effect.Effect<never> =>
  Effect.fail(e) as Effect.Effect<never>;

/**
 * E2B's error envelope — `{code: int, error_code?: string, message}` on the
 * control plane, `{code, message}` inside Connect error bodies. The semantic
 * `error_code` (a string) wins over the numeric `code` when present.
 */
const errorEnvelope = (
  body: unknown,
): { readonly code?: string | number; readonly message?: string } => {
  if (body === null || typeof body !== "object") return {};
  const b = body as Record<string, unknown>;
  const code =
    typeof b.error_code === "string"
      ? b.error_code
      : typeof b.code === "string" || typeof b.code === "number"
        ? b.code
        : undefined;
  const message =
    typeof b.message === "string"
      ? b.message
      : typeof b.error === "string"
        ? b.error
        : undefined;
  return { code, message };
};

/** Coerce a response-header string to the member's declared scalar type. */
const headerValue = (prop: AST.PropertySignature, raw: string): unknown => {
  const node = resolveNode(prop.type);
  switch (node._tag) {
    case "Number":
      return Number(raw);
    case "Boolean":
      return raw === "true";
    default:
      return raw;
  }
};

/**
 * Assemble the output object from body + response headers.
 *
 * A member marked `T.RawResponse` takes the WHOLE body (bare-array list
 * responses restructured in convert); every `T.Header` member reads its wire
 * name off the response headers; anything else goes through `mapKeys`.
 */
const assembleOutput = (
  outputAst: AST.AST,
  body: unknown,
  headers: Record<string, string | undefined>,
): unknown => {
  const props = getProps(outputAst);
  const rawProp = props.find((p) => hasPropAnn(p, rawResponseSymbol));

  const out: Record<string, unknown> =
    rawProp !== undefined
      ? { [String(rawProp.name)]: mapKeys(rawProp.type, body, "decode") }
      : ((mapKeys(outputAst, body, "decode") ?? {}) as Record<string, unknown>);

  for (const p of props) {
    if (rawProp !== undefined && p === rawProp) continue;
    if (!hasPropAnn(p, headerSymbol)) continue;
    const raw = headers[nameOf(p, headerSymbol).toLowerCase()];
    if (raw !== undefined) out[String(p.name)] = headerValue(p, raw);
  }
  return out;
};

interface WireError {
  readonly status: number;
  readonly code?: string | number;
  readonly message: string;
  readonly body: unknown;
  readonly headers: Record<string, string | undefined>;
}

/**
 * The failure ladder shared by REST and Connect-JSON failures:
 * per-op typed errors → status map → unmapped 5xx → UnknownE2BError.
 */
const failWithWireError = (
  errorClasses: ReadonlyArray<unknown>,
  info: WireError,
): Effect.Effect<never> => {
  const typed = matchTypedError(errorClasses, info.status, [
    {
      code: typeof info.code === "number" ? info.code : undefined,
      message: info.message,
    },
  ]);
  if (typed !== undefined) return fail(typed);

  const StatusErrorClass =
    info.status in HTTP_STATUS_MAP
      ? HTTP_STATUS_MAP[info.status as keyof typeof HTTP_STATUS_MAP]
      : undefined;
  if (StatusErrorClass) {
    return fail(
      new StatusErrorClass({
        message: info.message,
        retryAfter: parseRetryAfterForStatus(info.status, info.headers),
      }),
    );
  }
  if (info.status >= 500) {
    return fail(
      new InternalServerError({
        message: info.message,
        retryAfter: parseRetryAfterForStatus(info.status, info.headers),
      }),
    );
  }
  return fail(
    new UnknownE2BError({
      code: typeof info.code === "string" ? info.code : undefined,
      message: info.message,
      body: info.body,
    }),
  );
};

/**
 * REST decode: text → tolerant JSON → error ladder or header/raw-member
 * aware output assembly. Used by both planes for their JSON endpoints.
 */
const decodeRest = (
  response: HttpClientResponse.HttpClientResponse,
  outputAst: AST.AST,
  errorClasses: ReadonlyArray<unknown>,
) =>
  Effect.gen(function* () {
    // `T.HttpBody` OUTPUT member (envd's octet-stream file download): the
    // body is raw bytes, not JSON. Errors still come back as JSON text, so
    // read the body once and route on status.
    const httpBodyProp = getProps(outputAst).find((p) =>
      hasPropAnn(p, httpBodySymbol),
    );
    if (httpBodyProp !== undefined && response.status < 400) {
      const buf = new Uint8Array(
        yield* response.arrayBuffer.pipe(Effect.orDie),
      );
      return wrapSensitive(outputAst, { [String(httpBodyProp.name)]: buf });
    }

    const text = (yield* response.text.pipe(Effect.orDie)) ?? "";
    if (debugHttp()) {
      console.error(`[distilled] <- ${response.status} ${text.slice(0, 400)}`);
    }
    let json: unknown;
    let nonJson = false;
    if (text.trim().length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        nonJson = true;
      }
    }
    const status = response.status;
    const headers = response.headers as Record<string, string | undefined>;

    if (status >= 400) {
      const env = (nonJson ? undefined : errorEnvelope(json)) ?? {};
      const message =
        env.message ??
        (nonJson && text.trim() ? text.trim() : `HTTP ${status}`);
      return yield* failWithWireError(errorClasses, {
        status,
        code: env.code,
        message,
        body: nonJson ? text : json,
        headers,
      });
    }

    const body: unknown = nonJson ? text : (json ?? {});
    return wrapSensitive(outputAst, assembleOutput(outputAst, body, headers));
  });

/**
 * Pre-join `T.QueryJoin` array members (`explode: false` — E2B wants
 * `state=running,paused`, not repeated `state=` pairs). Everything else
 * reaches `buildRequest` untouched.
 */
const joinQueryMembers = (input: unknown, inputAst: AST.AST): unknown => {
  if (input === null || typeof input !== "object") return input;
  const joins: Array<{ name: string; separator: string }> = [];
  for (const prop of getProps(inputAst)) {
    const sep = getPropAnn(prop, queryJoinSymbol);
    if (sep !== undefined) {
      joins.push({
        name: String(prop.name),
        separator: typeof sep === "string" ? sep : ",",
      });
    }
  }
  if (joins.length === 0) return input;
  const obj = { ...(input as Record<string, unknown>) };
  for (const { name, separator } of joins) {
    const v = obj[name];
    if (Array.isArray(v)) obj[name] = v.join(separator);
  }
  return obj;
};

// =============================================================================
// Connect-RPC
// =============================================================================

/**
 * envd's Connect-RPC paths are `/<package>.<Service>/<Method>` — the first
 * path segment contains a dot (`process.Process`, `filesystem.Filesystem`);
 * envd's REST paths (`/envs`, `/files`, `/health`, …) never do.
 */
const CONNECT_PATH = /^\/[^/]*\.[^/]+\//;
const isConnectPath = (uri: string): boolean => CONNECT_PATH.test(uri);

/**
 * Connect error code → its canonical HTTP status. Connect maps codes onto
 * HTTP statuses for the unary protocol; using the same table keeps envd RPC
 * failures on the shared status-driven error ladder (and preserves the
 * adapter's status semantics).
 */
const CONNECT_CODE_STATUS: Readonly<Record<string, number>> = {
  canceled: 499,
  unknown: 500,
  invalid_argument: 400,
  deadline_exceeded: 504,
  not_found: 404,
  already_exists: 409,
  permission_denied: 403,
  resource_exhausted: 429,
  failed_precondition: 400,
  aborted: 409,
  out_of_range: 400,
  unimplemented: 501,
  internal: 500,
  unavailable: 503,
  data_loss: 500,
  unauthenticated: 401,
};

interface ConnectErrorBody {
  readonly code?: string;
  readonly message?: string;
}

const parseConnectError = (body: unknown): ConnectErrorBody | undefined => {
  if (body === null || typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;
  if (typeof b.code !== "string" && typeof b.message !== "string") {
    return undefined;
  }
  return {
    code: typeof b.code === "string" ? b.code : undefined,
    message: typeof b.message === "string" ? b.message : undefined,
  };
};

/** One Connect envelope: `0x00 | u32be(length) | payload` (flag 0 = message). */
const connectFrame = (payload: Uint8Array): Uint8Array => {
  const frame = new Uint8Array(5 + payload.length);
  new DataView(frame.buffer).setUint32(1, payload.length);
  frame.set(payload, 5);
  return frame;
};

/** Decode a Connect unary failure body and fail down the wire-error ladder. */
const failConnect = (
  response: HttpClientResponse.HttpClientResponse,
  errorClasses: ReadonlyArray<unknown>,
  text: string,
) =>
  Effect.gen(function* () {
    let json: unknown;
    try {
      json = text.trim().length > 0 ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    const headers = response.headers as Record<string, string | undefined>;
    const connect = parseConnectError(json);
    // A Connect-JSON error's `code` translates to the canonical HTTP status
    // for the error ladder; an HTTP-level failure (proxy, ingress) uses its
    // own status directly.
    const status =
      connect?.code !== undefined
        ? (CONNECT_CODE_STATUS[connect.code] ?? 500)
        : response.status >= 400
          ? response.status
          : 500;
    const message =
      connect?.message ??
      (typeof json === "object" ? errorEnvelope(json).message : undefined) ??
      (text.trim() ? text.trim() : `HTTP ${response.status}`);
    return yield* failWithWireError(errorClasses, {
      status,
      code: connect?.code ?? errorEnvelope(json).code,
      message,
      body: json ?? text,
      headers,
    });
  });

// =============================================================================
// E2BProtocol — control plane REST
// =============================================================================

const encodeRest = (
  headers: Record<string, string>,
  baseUrl: string,
  args: {
    readonly input: unknown;
    readonly inputAst: AST.AST;
  },
): HttpClientRequest.HttpClientRequest =>
  buildRequest({
    input: joinQueryMembers(args.input, args.inputAst),
    inputAst: args.inputAst,
    baseUrl,
    headers,
  });

export const E2BProtocol: Layer.Layer<API.Protocol> = Layer.succeed(
  API.Protocol,
  API.Protocol.of({
    encode: (args) =>
      Effect.gen(function* () {
        const resolve = yield* Credentials;
        const creds: Config = yield* resolve;
        const request = encodeRest(
          { "x-api-key": Redacted.value(creds.apiKey) },
          creds.apiBaseUrl,
          args,
        );
        if (debugHttp()) {
          console.error(`[distilled] ${request.method} ${request.url}`);
        }
        return request;
      }) as Effect.Effect<HttpClientRequest.HttpClientRequest>,
    decode: ({ response, outputAst, errors }) =>
      decodeRest(response, outputAst, errors),
  }),
);

// =============================================================================
// E2BEnvdProtocol — per-sandbox envd (REST + Connect-RPC)
// =============================================================================

const envdHeaders = (conn: EnvdConnectionValue): Record<string, string> =>
  conn.headers;

const encodeEnvd = (
  conn: EnvdConnectionValue,
  args: {
    readonly input: unknown;
    readonly inputAst: AST.AST;
  },
): Effect.Effect<HttpClientRequest.HttpClientRequest> =>
  Effect.gen(function* () {
    const http = getAnn(args.inputAst, httpSymbol) as HttpTrait | undefined;
    if (http?.uri === undefined) {
      return yield* fail(
        new Error(
          "envd protocol requires the input schema to carry T.Http (the RPC path or REST route)",
        ),
      );
    }
    const uri = http.uri;

    if (isConnectPath(uri)) {
      // Connect-RPC: binary protobuf payload — raw for unary calls, one
      // envelope for server-streaming calls (T.ConnectStream inputs).
      const payload = encodeMessage(args.inputAst, args.input);
      const streaming = getAnn(args.inputAst, connectStreamSymbol) === true;
      return HttpClientRequest.post(`${conn.baseUrl}${uri}`).pipe(
        HttpClientRequest.bodyUint8Array(
          streaming ? connectFrame(payload) : payload,
        ),
        HttpClientRequest.setHeaders({
          "content-type": streaming
            ? "application/connect+proto"
            : "application/proto",
          ...envdHeaders(conn),
        }),
      );
    }

    return encodeRest(envdHeaders(conn), conn.baseUrl, {
      input: args.input,
      inputAst: args.inputAst,
    });
  });

const decodeEnvdUnary = (
  uri: string,
  response: HttpClientResponse.HttpClientResponse,
  outputAst: AST.AST,
  errorClasses: ReadonlyArray<unknown>,
) =>
  Effect.gen(function* () {
    if (!isConnectPath(uri)) {
      return yield* decodeRest(response, outputAst, errorClasses);
    }
    const buf = new Uint8Array(yield* response.arrayBuffer.pipe(Effect.orDie));
    if (response.status !== 200) {
      const text = new TextDecoder().decode(buf);
      return yield* failConnect(response, errorClasses, text);
    }
    if (buf.length === 0) return wrapSensitive(outputAst, {});
    return wrapSensitive(outputAst, decodeMessage(outputAst, buf));
  });

/**
 * Incremental Connect-envelope splitter over a response body stream: `0x00`
 * frames decode as messages; the terminal `0x02` frame is the EndStream
 * JSON (`{error?, metadata?}`) whose error, when present, fails the stream's
 * tail. EOF before an end frame is tolerated — the envd ingress may close
 * the body cleanly after the last message.
 */
const decodeEnvdStream = (
  response: HttpClientResponse.HttpClientResponse,
  outputAst: AST.AST,
  errorClasses: ReadonlyArray<unknown>,
): Stream.Stream<unknown, unknown> => {
  if (response.status !== 200) {
    return Stream.unwrap(
      Effect.map(response.text.pipe(Effect.orDie), (text) =>
        Stream.fromEffect(failConnect(response, errorClasses, text ?? "")),
      ),
    );
  }

  let buf = new Uint8Array(0);
  let offset = 0;
  let terminalError: unknown;
  const feed = (chunk: Uint8Array): ReadonlyArray<Uint8Array> => {
    if (offset > 0) {
      buf = buf.subarray(offset);
      offset = 0;
    }
    const merged = new Uint8Array(buf.length + chunk.length);
    merged.set(buf);
    merged.set(chunk, buf.length);
    buf = merged;

    const frames: Array<Uint8Array> = [];
    while (buf.length - offset >= 5) {
      const flag = buf[offset]!;
      const len = new DataView(
        buf.buffer,
        buf.byteOffset + offset + 1,
        4,
      ).getUint32(0);
      if (buf.length - offset - 5 < len) break;
      const payload = buf.subarray(offset + 5, offset + 5 + len);
      offset += 5 + len;
      if (flag === 0) {
        frames.push(payload);
      } else if (flag === 0x02) {
        // EndStreamResponse — JSON `{error?: {code, message, details}}`.
        try {
          const end = JSON.parse(new TextDecoder().decode(payload)) as {
            readonly error?: {
              readonly code?: string;
              readonly message?: string;
            };
          };
          if (end?.error !== undefined) {
            const code = end.error.code;
            terminalError = new UnknownE2BError({
              code,
              message: end.error.message ?? `connect error ${code ?? "?"}`,
              body: end,
            });
          }
        } catch {
          // Malformed end frame — ignore; the message stream is what matters.
        }
      }
    }
    return frames;
  };

  return Stream.concat(
    response.stream.pipe(
      Stream.flatMap((chunk) => Stream.fromIterable(feed(chunk))),
      Stream.map((payload) =>
        wrapSensitive(outputAst, decodeMessage(outputAst, payload)),
      ),
    ),
    Stream.suspend(() =>
      terminalError !== undefined ? Stream.fail(terminalError) : Stream.empty,
    ),
  );
};

export const E2BEnvdProtocol: Layer.Layer<API.Protocol> = Layer.succeed(
  API.Protocol,
  API.Protocol.of({
    encode: (args) =>
      Effect.gen(function* () {
        const conn = yield* EnvdConnection;
        const request = yield* encodeEnvd(conn, args);
        if (debugHttp()) {
          console.error(`[distilled] ${request.method} ${request.url}`);
        }
        return request;
      }) as Effect.Effect<HttpClientRequest.HttpClientRequest>,
    decode: ({ response, outputAst, errors, config }) => {
      const http =
        config.input !== undefined
          ? (getAnn(config.input.ast, httpSymbol) as HttpTrait | undefined)
          : undefined;
      return decodeEnvdUnary(http?.uri ?? "", response, outputAst, errors);
    },
    decodeStream: ({ response, outputAst, errors }) =>
      decodeEnvdStream(response, outputAst, errors),
  }),
);
