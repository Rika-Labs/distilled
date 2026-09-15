/**
 * SandboxBridgeProtocol — the `@cloudflare/sandbox` bridge worker's HTTP API.
 *
 * The bridge (the SDK's `bridge()` wrapper, OpenAPI embedded as
 * `OPENAPI_SCHEMA` in `dist/bridge/index.js`) is a REST JSON API for most
 * operations — those ride core's `makeRestProtocol` verbatim, dispatching
 * on `T.Http`/`T.Label`/`T.Body`/`T.Header` annotations.
 *
 * Three operations cannot go through the generic path and are handled by
 * operationName here:
 *
 * - `execSandbox` — request is ordinary REST JSON (delegated to the inner
 *   REST protocol's encode), but the 200 response is `text/event-stream`
 *   (`event: stdout|stderr` with base64 `data:`; terminal `exit`/`error`
 *   events with JSON `data:`). Surfaced via `decodeStream` as
 *   `ExecSandboxEvent` elements — one per SSE frame.
 *
 * - `readSandboxFile` / `writeSandboxFile` — the file path is a RAW URL
 *   suffix: the route is `app.get("/v1/sandbox/:id/file/*")` and the
 *   worker slices `c.req.path` (the undecoded pathname) after the literal
 *   `/file/` marker. Percent-encoding the path (as label substitution
 *   would) makes the worker resolve a literal `%2F`-bearing name, so these
 *   ops build the URL by hand. Write bodies are `application/octet-stream`
 *   (32 MiB server-side limit); read responses are `application/octet-
 *   stream` decoded to `Uint8Array` (or the typed JSON error body).
 *
 * Non-2xx responses on every op decode through the same JSON
 * `{error, code}` envelope as the REST path (typed matchers, status map,
 * `UnknownCloudflareSandboxError` fallback).
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Filter from "effect/Filter";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as API from "@rikalabs/distilled-core/api";
import type { ConfigError } from "@rikalabs/distilled-core/errors";
import {
  HTTP_STATUS_MAP,
  InternalServerError,
} from "@rikalabs/distilled-core/errors";
import {
  makeRestProtocol,
  type RestErrorInfo,
} from "@rikalabs/distilled-core/protocol-rest";
import { matchTypedError } from "@rikalabs/distilled-core/protocol-http";
import { parseRetryAfterForStatus } from "@rikalabs/distilled-core/retry-after";
import { Credentials, type Config } from "./credentials.ts";
import {
  CloudflareSandboxParseError,
  UnknownCloudflareSandboxError,
  type DefaultErrors,
} from "./errors.ts";
import type { ExecSandboxEvent } from "./exec.ts";

/**
 * Error channel shared by every generated Cloudflare Sandbox operation.
 * Generated service files annotate operations with
 * `API.OperationMethod<I, O, SandboxBridgeOpError, SandboxBridgeOpContext>`
 * explicitly so the compiler never infers these back out of the schema
 * generics.
 */
export type SandboxBridgeOpError =
  | DefaultErrors
  | ConfigError
  | HttpClientError.HttpClientError;

/** Context (requirements) shared by every generated Cloudflare Sandbox operation. */
export type SandboxBridgeOpContext = Credentials | HttpClient.HttpClient;

// =============================================================================
// Wire helpers for the non-generic operations
// =============================================================================

const API_PREFIX = "/v1";

/** Bridge sandbox ids are `[a-z2-7]{1,128}` — label-encoding is safe. */
const sandboxUrl = (creds: Config, id: string, suffix: string): string =>
  `${creds.apiBaseUrl.replace(/\/$/, "")}${API_PREFIX}/sandbox/${encodeURIComponent(id)}${suffix}`;

const authHeaders = (creds: Config): Record<string, string> =>
  creds.apiKey === undefined
    ? {}
    : { authorization: `Bearer ${Redacted.value(creds.apiKey)}` };

/**
 * The file path is the raw remainder of the URL path after the literal
 * `/file/` marker — the worker slices `c.req.path` undecoded, so `/` must
 * NOT be percent-encoded. A leading `/` is stripped (the worker prepends
 * one itself before resolving under `/workspace`).
 */
const fileUrl = (creds: Config, id: string, path: string): string =>
  sandboxUrl(creds, id, `/file/${path.replace(/^\/+/, "")}`);

// =============================================================================
// Shared error decode — the same `{error, code}` JSON envelope everywhere
// =============================================================================

const errorEnvelope = (
  body: unknown,
): { code?: string | number; message?: string } | undefined => {
  if (body === null || typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;
  const code =
    typeof b.code === "string" || typeof b.code === "number"
      ? b.code
      : undefined;
  const message =
    typeof b.error === "string"
      ? b.error
      : typeof b.message === "string"
        ? b.message
        : undefined;
  return { code, message };
};

const fail = (e: unknown): Effect.Effect<never> =>
  Effect.fail(e) as Effect.Effect<never>;

/**
 * Turn a failed response into the operation's typed error — mirrors the
 * REST protocol's precedence: per-op matcher classes, status map, unmapped
 * 5xx → InternalServerError, then the unknown fallback. Reads the body as
 * tolerant JSON (error pages may not be).
 */
const decodeError = (
  response: HttpClientResponse.HttpClientResponse,
  errorClasses: ReadonlyArray<unknown>,
): Effect.Effect<never> =>
  Effect.gen(function* () {
    const text = (yield* response.text.pipe(Effect.orDie)) ?? "";
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
    const env = (nonJson ? undefined : errorEnvelope(json)) ?? {};
    const message =
      env.message ?? (nonJson && text.trim() ? text.trim() : `HTTP ${status}`);

    const typed = matchTypedError(errorClasses, status, [
      { code: typeof env.code === "number" ? env.code : undefined, message },
    ]);
    if (typed !== undefined) return yield* fail(typed);

    const statusMap: Readonly<
      Record<number, (new (args: any) => any) | undefined>
    > = HTTP_STATUS_MAP;
    const StatusErrorClass = statusMap[status];
    if (StatusErrorClass) {
      return yield* fail(
        new StatusErrorClass({
          message,
          retryAfter: parseRetryAfterForStatus(status, headers),
        }),
      );
    }
    if (status >= 500) {
      return yield* fail(
        new InternalServerError({
          message,
          retryAfter: parseRetryAfterForStatus(status, headers),
        }),
      );
    }
    return yield* fail(
      unknownError({
        status,
        code: env.code,
        message,
        body: nonJson ? text : json,
        headers,
      }),
    );
  });

const unknownError = (info: RestErrorInfo): UnknownCloudflareSandboxError =>
  new UnknownCloudflareSandboxError({
    code: info.code !== undefined ? String(info.code) : `http:${info.status}`,
    message: info.message,
    body: info.body,
  });

// =============================================================================
// Special encodes — file I/O (raw path suffix / octet-stream body)
// =============================================================================

interface FileOpInput {
  readonly id: string;
  readonly path: string;
  readonly sessionId?: string | undefined;
  readonly data?: Uint8Array | undefined;
}

const sessionHeader = (input: FileOpInput): Record<string, string> =>
  input.sessionId === undefined ? {} : { "session-id": input.sessionId };

const encodeReadFile = (creds: Config, input: FileOpInput) =>
  HttpClientRequest.get(fileUrl(creds, input.id, input.path)).pipe(
    HttpClientRequest.setHeaders({
      ...authHeaders(creds),
      ...sessionHeader(input),
    }),
  );

const encodeWriteFile = (creds: Config, input: FileOpInput) =>
  HttpClientRequest.put(fileUrl(creds, input.id, input.path)).pipe(
    HttpClientRequest.setHeaders({
      ...authHeaders(creds),
      ...sessionHeader(input),
    }),
    HttpClientRequest.bodyUint8Array(
      input.data ?? new Uint8Array(0),
      "application/octet-stream",
    ),
  );

// =============================================================================
// Special decodes
// =============================================================================

/**
 * `GET …/file/*` 2xx — the whole body is the file. Errors are JSON, so a
 * non-2xx response routes through the shared envelope decode.
 */
const decodeReadFile = (
  response: HttpClientResponse.HttpClientResponse,
  errorClasses: ReadonlyArray<unknown>,
): Effect.Effect<unknown> =>
  response.status >= 400
    ? decodeError(response, errorClasses)
    : Effect.map(
        Effect.orDie(response.arrayBuffer),
        (buf) => new Uint8Array(buf),
      );

// =============================================================================
// SSE decode — execSandbox
// =============================================================================

interface SseFrame {
  readonly event: string;
  readonly data: string;
}

interface SseState {
  readonly event: string | undefined;
  readonly data: ReadonlyArray<string>;
}

const EMPTY_STATE: SseState = { event: undefined, data: [] };

/**
 * Incremental SSE framing: `event:`/`data:` lines accumulate until a blank
 * line flushes one frame. Comment (`:`) and unknown lines are ignored —
 * the worker may interleave keepalives.
 */
const flush = (state: SseState): ReadonlyArray<SseFrame> =>
  state.event === undefined && state.data.length === 0
    ? []
    : [
        {
          event: state.event ?? "message",
          data: state.data.join("\n"),
        },
      ];

const frames = (
  stream: Stream.Stream<Uint8Array, unknown>,
): Stream.Stream<SseFrame, unknown> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.mapAccum(
      () => EMPTY_STATE,
      (state, line): readonly [SseState, ReadonlyArray<SseFrame>] => {
        if (line === "") {
          return [EMPTY_STATE, flush(state)];
        }
        if (line.startsWith(":")) return [state, []];
        if (line.startsWith("data:")) {
          const raw = line.slice(5);
          return [
            {
              event: state.event,
              data: [...state.data, raw.startsWith(" ") ? raw.slice(1) : raw],
            },
            [],
          ];
        }
        if (line.startsWith("event:")) {
          return [{ event: line.slice(6).trim(), data: state.data }, []];
        }
        return [state, []];
      },
      { onHalt: flush },
    ),
  );

const parseJson = (
  data: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } => {
  try {
    return { ok: true as const, value: JSON.parse(data) };
  } catch {
    return { ok: false as const };
  }
};

/**
 * One SSE frame → optionally one `ExecSandboxEvent`. `stdout`/`stderr` data
 * is base64; `exit` data is `{"exit_code": N}`; `error` data is
 * `{error, code}`. Unrecognized event names (future keepalives) are
 * skipped; a malformed payload fails the stream with
 * `CloudflareSandboxParseError` rather than emitting a corrupted event.
 */
const toEvent = (
  frame: SseFrame,
): Effect.Effect<
  Option.Option<ExecSandboxEvent>,
  CloudflareSandboxParseError
> => {
  switch (frame.event) {
    case "stdout":
    case "stderr": {
      const decoded = Encoding.decodeBase64(frame.data);
      return decoded._tag === "Success"
        ? Effect.succeed(
            Option.some({
              _tag: frame.event,
              data: decoded.success,
            } as ExecSandboxEvent),
          )
        : Effect.fail(
            new CloudflareSandboxParseError({
              body: frame.data,
              cause: decoded._tag,
            }),
          );
    }
    case "exit": {
      const parsed = parseJson(frame.data);
      const exitCode =
        parsed.ok &&
        parsed.value !== null &&
        typeof parsed.value === "object" &&
        typeof (parsed.value as Record<string, unknown>).exit_code === "number"
          ? (parsed.value as { exit_code: number }).exit_code
          : undefined;
      return exitCode !== undefined
        ? Effect.succeed(
            Option.some({ _tag: "exit", exitCode } as ExecSandboxEvent),
          )
        : Effect.fail(
            new CloudflareSandboxParseError({
              body: frame.data,
              cause: "exit event without numeric exit_code",
            }),
          );
    }
    case "error": {
      const parsed = parseJson(frame.data);
      const value =
        parsed.ok && parsed.value !== null && typeof parsed.value === "object"
          ? (parsed.value as Record<string, unknown>)
          : {};
      return Effect.succeed(
        Option.some({
          _tag: "error",
          error:
            typeof value.error === "string"
              ? value.error
              : "unknown exec error",
          code: typeof value.code === "string" ? value.code : undefined,
        } as ExecSandboxEvent),
      );
    }
    default:
      return Effect.succeed(Option.none());
  }
};

const decodeExecStream = (
  response: HttpClientResponse.HttpClientResponse,
  errorClasses: ReadonlyArray<unknown>,
): Stream.Stream<ExecSandboxEvent, unknown> =>
  response.status >= 400
    ? Stream.unwrap(
        Effect.map(
          decodeError(response, errorClasses).pipe(Effect.flip),
          Stream.fail,
        ),
      )
    : frames(response.stream).pipe(
        Stream.mapEffect(toEvent),
        Stream.filterMap(Filter.fromPredicateOption((option) => option)),
      );

// =============================================================================
// Protocol layer
// =============================================================================

const credentials: Effect.Effect<Config, ConfigError, Credentials> = Effect.gen(
  function* () {
    const resolve = yield* Credentials;
    return yield* resolve;
  },
);

const rest = makeRestProtocol<Config>({
  credentials,
  baseUrl: (creds) => creds.apiBaseUrl.replace(/\/$/, ""),
  headers: authHeaders,
  errorEnvelope,
  unknownError,
});

export const SandboxBridgeProtocol: Layer.Layer<API.Protocol> = Layer.flatMap(
  rest,
  (ctx) => {
    const inner = Context.get(ctx, API.Protocol);
    return Layer.succeed(
      API.Protocol,
      API.Protocol.of({
        encode: (args) => {
          const input = args.input as FileOpInput;
          switch (args.config.operationName) {
            case "readSandboxFile":
              return Effect.map(credentials as Effect.Effect<Config>, (creds) =>
                encodeReadFile(creds, input),
              );
            case "writeSandboxFile":
              return Effect.map(credentials as Effect.Effect<Config>, (creds) =>
                encodeWriteFile(creds, input),
              );
            default:
              return inner.encode(args);
          }
        },
        decode: (args) =>
          args.config.operationName === "readSandboxFile"
            ? decodeReadFile(args.response, args.errors)
            : inner.decode(args),
        decodeStream: (args) => decodeExecStream(args.response, args.errors),
      }),
    );
  },
);
