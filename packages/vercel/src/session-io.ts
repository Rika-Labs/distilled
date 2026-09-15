/**
 * SessionIo — hand-written transport helpers for the sandbox session
 * endpoints whose bodies are not JSON.
 *
 * The generated service surface only models JSON request/response bodies, so
 * three session endpoints are implemented here against the same `Credentials`
 * service, `HttpClient`, and error mapping the generated operations use:
 *
 * - `readSessionFile` — `POST /v2/sandboxes/sessions/{id}/fs/read` returns
 *   `application/octet-stream`, not a JSON payload.
 * - `writeSessionFiles` — `POST /v2/sandboxes/sessions/{id}/fs/write` accepts a
 *   gzipped tar archive plus the `x-cwd` extraction-directory header.
 * - `sessionCommandLogs` — `GET /v2/sandboxes/sessions/{id}/cmd/{cmdId}/logs`
 *   streams NDJSON log records (`stdout`/`stderr`/`error`).
 *
 * Every helper carries the same context (`Credentials | HttpClient`) and the
 * same error channel (`VercelOpError`) as a generated operation.
 */
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as Ndjson from "effect/unstable/encoding/Ndjson";
import {
  HTTP_STATUS_MAP,
  InternalServerError,
  type ConfigError,
} from "@rikalabs/distilled-core/errors";
import { Credentials } from "./credentials.ts";
import {
  BadRequest,
  Conflict,
  Forbidden,
  Gone,
  Locked,
  NotFound,
  PaymentRequired,
  Unauthorized,
  UnknownVercelError,
  UnprocessableEntity,
  VercelParseError,
  type DefaultErrors,
} from "./errors.ts";
import type { VercelOpContext } from "./protocol.ts";

/**
 * The error channel of these helpers: the same status errors, fallback errors,
 * and transport errors a generated operation can raise.
 */
export type SessionIoError =
  | DefaultErrors
  | BadRequest
  | Unauthorized
  | Forbidden
  | NotFound
  | Conflict
  | UnprocessableEntity
  | Locked
  | ConfigError
  | HttpClientError.HttpClientError;

/** HTTP status → error class, mirroring `VercelProtocol`'s map. */
const STATUS_ERRORS: Readonly<
  Record<number, new (args: { readonly message: string }) => SessionIoError>
> = {
  ...HTTP_STATUS_MAP,
  402: PaymentRequired,
  410: Gone,
};

const errorEnvelope = (
  body: unknown,
): { code?: string; message?: string } | undefined => {
  if (body === null || typeof body !== "object") return undefined;
  const err = (body as Record<string, unknown>).error;
  if (err === null || typeof err !== "object") return undefined;
  const e = err as Record<string, unknown>;
  return {
    code: typeof e.code === "string" ? e.code : undefined,
    message: typeof e.message === "string" ? e.message : undefined,
  };
};

/**
 * Turn a non-2xx response into the shared typed-error channel, mirroring
 * `makeRestProtocol`'s decode: status-mapped class, `InternalServerError` for
 * unmapped 5xx, `UnknownVercelError` otherwise.
 */
const failResponse = (
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<never, SessionIoError> =>
  Effect.gen(function* () {
    const text = (yield* response.text.pipe(Effect.orDie)) ?? "";
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    const env = errorEnvelope(json) ?? {};
    const message =
      env.message ??
      (text.trim().length > 0 ? text.trim() : `HTTP ${response.status}`);
    const StatusError = STATUS_ERRORS[response.status];
    if (StatusError !== undefined) {
      return yield* Effect.fail(new StatusError({ message }));
    }
    if (response.status >= 500) {
      return yield* Effect.fail(new InternalServerError({ message }));
    }
    return yield* Effect.fail(
      new UnknownVercelError({
        code: env.code,
        message,
        body: json ?? text,
      }),
    );
  });

/**
 * Execute one request against `apiBaseUrl` with bearer auth, the same way the
 * generated operations do. Team scoping rides the `teamId`/`slug` query
 * parameters exactly like generated request members.
 */
const execute = (options: {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly query?: Record<string, string | undefined> | undefined;
  readonly headers?: Record<string, string> | undefined;
  readonly body?:
    | ((
        request: HttpClientRequest.HttpClientRequest,
      ) => HttpClientRequest.HttpClientRequest)
    | undefined;
}): Effect.Effect<
  HttpClientResponse.HttpClientResponse,
  SessionIoError,
  VercelOpContext
> =>
  Effect.gen(function* () {
    const resolve = yield* Credentials;
    const credentials = yield* resolve;
    const client = yield* HttpClient.HttpClient;

    const urlParams: Record<string, string> = {};
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) urlParams[key] = value;
    }

    let request = HttpClientRequest.make(options.method)(
      `${credentials.apiBaseUrl}${options.path}`,
      { urlParams },
    );
    request = HttpClientRequest.setHeader(
      request,
      "Authorization",
      `Bearer ${Redacted.value(credentials.token)}`,
    );
    for (const [key, value] of Object.entries(options.headers ?? {})) {
      request = HttpClientRequest.setHeader(request, key, value);
    }
    if (options.body !== undefined) request = options.body(request);

    return yield* client.execute(request);
  });

const teamQuery = (input: {
  teamId?: string | undefined;
  slug?: string | undefined;
}) => ({
  teamId: input.teamId,
  slug: input.slug,
});

/**
 * Read a file from a session's filesystem.
 *
 * `POST /v2/sandboxes/sessions/{sessionId}/fs/read` streams the raw file
 * content back as `application/octet-stream`. Resolves `null` when the file
 * does not exist (404), matching the official SDK's `readFileToBuffer`.
 */
export const readSessionFile = (input: {
  /** The unique identifier of the session to read the file from. */
  readonly sessionId: string;
  /** The path of the file to read. Can be absolute or relative to `cwd`. */
  readonly path: string;
  /** The base directory for resolving relative paths. */
  readonly cwd?: string | undefined;
  /** The Team identifier to perform the request on behalf of. */
  readonly teamId?: string | undefined;
  /** The Team slug to perform the request on behalf of. */
  readonly slug?: string | undefined;
}): Effect.Effect<Uint8Array | null, SessionIoError, VercelOpContext> =>
  Effect.gen(function* () {
    const body: Record<string, string> = { path: input.path };
    if (input.cwd !== undefined) body.cwd = input.cwd;

    const response = yield* execute({
      method: "POST",
      path: `/v2/sandboxes/sessions/${encodeURIComponent(input.sessionId)}/fs/read`,
      query: teamQuery(input),
      body: (request) =>
        HttpClientRequest.bodyText(
          request,
          JSON.stringify(body),
          "application/json",
        ),
    });

    if (response.status === 404) return null;
    if (response.status >= 400) return yield* failResponse(response);

    return new Uint8Array(yield* response.arrayBuffer);
  });

// ============================================================================
// Tar archive writing (ustar, single pass, in-memory)
// ============================================================================

const writeOctal = (
  view: Uint8Array,
  offset: number,
  length: number,
  value: number,
): void => {
  const text = value
    .toString(8)
    .padStart(length - 1, "0")
    .slice(-(length - 1));
  for (let i = 0; i < text.length; i++) view[offset + i] = text.charCodeAt(i);
  view[offset + length - 1] = 0;
};

const writeString = (
  view: Uint8Array,
  offset: number,
  length: number,
  value: string,
): void => {
  for (let i = 0; i < Math.min(value.length, length); i++) {
    view[offset + i] = value.charCodeAt(i) & 0x7f;
  }
};

/**
 * Encode a POSIX path segment relative to an extraction directory, mirroring
 * the official SDK's `normalizePath`: relative paths resolve against `cwd`,
 * `..` and duplicate slashes collapse, and the result is relative to
 * `extractDir`.
 */
const normalizePath = (
  filePath: string,
  cwd: string,
  extractDir: string,
): string => {
  const normalize = (input: string): string => {
    const segments: Array<string> = [];
    for (const segment of input.split("/")) {
      if (segment === "" || segment === ".") continue;
      if (segment === "..") {
        if (segments.length > 0 && segments[segments.length - 1] !== "..") {
          segments.pop();
        } else {
          segments.push("..");
        }
      } else {
        segments.push(segment);
      }
    }
    return segments.join("/");
  };
  const base = filePath.startsWith("/")
    ? normalize(filePath)
    : normalize(`${cwd}/${filePath}`);
  const root = normalize(extractDir);
  if (root === "") return base;
  if (base === root) return "";
  if (base.startsWith(`${root}/`)) return base.slice(root.length + 1);
  const rootSegments = root.split("/");
  const baseSegments = base.split("/");
  let shared = 0;
  while (
    shared < rootSegments.length &&
    shared < baseSegments.length &&
    rootSegments[shared] === baseSegments[shared]
  ) {
    shared++;
  }
  const ups = rootSegments.length - shared;
  return [
    ...Array.from({ length: ups }, () => ".."),
    ...baseSegments.slice(shared),
  ].join("/");
};

const tarEntry = (
  name: string,
  content: Uint8Array,
  mode: number,
): Uint8Array => {
  const out = new Uint8Array(512 + Math.ceil(content.byteLength / 512) * 512);
  writeString(out, 0, 100, name);
  writeOctal(out, 100, 8, mode);
  writeOctal(out, 108, 8, 0);
  writeOctal(out, 116, 8, 0);
  writeOctal(out, 124, 12, content.byteLength);
  writeOctal(out, 136, 12, Math.floor(Date.now() / 1000));
  out[156] = "0".charCodeAt(0);
  writeString(out, 257, 6, "ustar");
  out[263] = "0".charCodeAt(0);
  out[264] = "0".charCodeAt(0);
  writeString(out, 265, 32, "sandbox");
  writeString(out, 297, 32, "sandbox");
  let checksum = 0;
  for (let i = 0; i < 512; i++) {
    checksum += i >= 148 && i < 156 ? 32 : (out[i] ?? 0);
  }
  const digits = checksum.toString(8).padStart(6, "0");
  for (let i = 0; i < 6; i++) out[148 + i] = digits.charCodeAt(i);
  out[154] = 0;
  out[155] = 32;
  out.set(content, 512);
  return out;
};

const buildTar = (
  files: ReadonlyArray<{ name: string; content: Uint8Array; mode: number }>,
): Uint8Array => {
  const entries = files.map((file) =>
    tarEntry(file.name, file.content, file.mode),
  );
  const out = new Uint8Array(
    entries.reduce((total, entry) => total + entry.byteLength, 0) + 1024,
  );
  let offset = 0;
  for (const entry of entries) {
    out.set(entry, offset);
    offset += entry.byteLength;
  }
  return out;
};

const gzip = (bytes: Uint8Array): Effect.Effect<Uint8Array, SessionIoError> =>
  Effect.tryPromise({
    try: async () => {
      const stream = new Blob([bytes.buffer as ArrayBuffer])
        .stream()
        .pipeThrough(new CompressionStream("gzip"));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    },
    catch: (cause) =>
      new UnknownVercelError({
        message: "Failed to gzip the file archive",
        body: cause instanceof Error ? cause.message : String(cause),
      }),
  });

/**
 * Write files into a session's filesystem.
 *
 * `POST /v2/sandboxes/sessions/{sessionId}/fs/write` receives a gzipped tar
 * archive in the request body; the `x-cwd` header names the absolute
 * directory the archive is extracted into. Entry names inside the archive
 * are resolved relative to `extractDir` exactly like the official SDK:
 * relative `path`s resolve against `cwd` first.
 */
export const writeSessionFiles = (input: {
  /** The unique identifier of the session to write files to. */
  readonly sessionId: string;
  /** Files to write; `path` may be absolute or relative to `cwd`. */
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly content: Uint8Array;
    readonly mode?: number | undefined;
  }>;
  /** Absolute working directory used to resolve relative file paths. */
  readonly cwd: string;
  /** Absolute directory the archive is extracted into. Defaults to "/". */
  readonly extractDir?: string | undefined;
  /** The Team identifier to perform the request on behalf of. */
  readonly teamId?: string | undefined;
  /** The Team slug to perform the request on behalf of. */
  readonly slug?: string | undefined;
}): Effect.Effect<void, SessionIoError, VercelOpContext> =>
  Effect.gen(function* () {
    const extractDir = input.extractDir ?? "/";
    const archive = buildTar(
      input.files.map((file) => ({
        name: normalizePath(file.path, input.cwd, extractDir),
        content: file.content,
        mode: file.mode ?? 0o644,
      })),
    );
    const body = yield* gzip(archive);

    const response = yield* execute({
      method: "POST",
      path: `/v2/sandboxes/sessions/${encodeURIComponent(input.sessionId)}/fs/write`,
      query: teamQuery(input),
      headers: { "x-cwd": extractDir },
      body: (request) =>
        HttpClientRequest.bodyUint8Array(request, body, "application/gzip"),
    });

    if (response.status >= 400) return yield* failResponse(response);
  });

// ============================================================================
// Command log streaming (NDJSON)
// ============================================================================

/** One record of the `/cmd/{cmdId}/logs` NDJSON stream. */
export const CommandLog = Schema.Union([
  Schema.Struct({
    stream: Schema.Literal("stdout"),
    data: Schema.String,
  }),
  Schema.Struct({
    stream: Schema.Literal("stderr"),
    data: Schema.String,
  }),
  Schema.Struct({
    stream: Schema.Literal("error"),
    data: Schema.Struct({
      code: Schema.String,
      message: Schema.String,
    }),
  }),
]);
export type CommandLog = Schema.Schema.Type<typeof CommandLog>;

/**
 * Stream the output of a session command in real time.
 *
 * `GET /v2/sandboxes/sessions/{sessionId}/cmd/{cmdId}/logs` answers
 * `application/x-ndjson` with one `{ stream, data }` record per line.
 * `error` records fail the stream with `UnknownVercelError` carrying the
 * provider code/message, matching the official SDK's `StreamError` surface.
 */
export const sessionCommandLogs = (input: {
  /** The unique identifier of the session containing the command. */
  readonly sessionId: string;
  /** The unique identifier of the command to stream logs for. */
  readonly cmdId: string;
  /** The Team identifier to perform the request on behalf of. */
  readonly teamId?: string | undefined;
  /** The Team slug to perform the request on behalf of. */
  readonly slug?: string | undefined;
}): Stream.Stream<CommandLog, SessionIoError, VercelOpContext> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const response = yield* execute({
        method: "GET",
        path: `/v2/sandboxes/sessions/${encodeURIComponent(input.sessionId)}/cmd/${encodeURIComponent(input.cmdId)}/logs`,
        query: teamQuery(input),
      });

      if (response.status >= 400) return yield* failResponse(response);

      return response.stream.pipe(
        Stream.pipeThroughChannel(Ndjson.decode({ ignoreEmptyLines: true })),
        Stream.mapEffect((line) =>
          Schema.decodeUnknownEffect(CommandLog)(line),
        ),
        Stream.mapError((cause): SessionIoError => {
          if (HttpClientError.isHttpClientError(cause)) return cause;
          return new VercelParseError({ body: undefined, cause });
        }),
        Stream.flatMap((log) =>
          log.stream === "error"
            ? Stream.fail(
                new UnknownVercelError({
                  code: log.data.code,
                  message: log.data.message,
                  body: log.data,
                }),
              )
            : Stream.succeed(log),
        ),
      );
    }),
  );
