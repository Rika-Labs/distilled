/**
 * Generic unary gRPC protocol factory for proto-sourced SDKs
 * (`Content-Type: application/grpc`, binary protobuf over plain HTTP/1.1 or
 * HTTP/2 — no client-streaming).
 *
 * `makeGrpcProtocol(options)` builds a core {@link API.Protocol} layer:
 *
 *   request:  credentials resolved from the CALLING fiber's context on every
 *             request (the layer itself is memoized per process — see
 *             `core/api`); the operation's `T.Http` trait supplies the
 *             `/<package>.<Service>/<Method>` path; the input is encoded
 *             with `core/protobuf`'s schema-driven codec and sent as one
 *             uncompressed gRPC frame
 *
 *   response: `grpc-status` in the response HEADERS is authoritative
 *             (envoy-style frontends expose it there on both success and
 *             trailers-only failure — fetch cannot see real trailers); the
 *             first message frame (flag `0x00`) in the body is the payload,
 *             decoded with the same schema-driven codec; trailer frames
 *             (`0x80`) are skipped; a nonzero status or a missing frame on
 *             a non-empty-body response surfaces via `unknownError`.
 *
 * Providers that need a token exchange before ordinary calls (Modal's
 * `AuthTokenGet` → `x-modal-auth-token`) hook `authenticate`: it runs on
 * the calling fiber with `HttpClient` in context, receives the op's gRPC
 * path so bootstrap RPCs can opt out, and returns extra headers. The hook
 * owns its own caching/refresh.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type * as AST from "effect/SchemaAST";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as API from "./api.ts";
import { debugHttp } from "./env.ts";
import { decodeMessage, encodeMessage, Reader } from "./protobuf.ts";
import { getAnn } from "./protocol-http.ts";
import { unwrapRedactedDeep, wrapSensitive } from "./protocol-rest.ts";
import { httpSymbol, type HttpTrait } from "./trait.ts";

/** gRPC status code → name, per the canonical status-code enum. */
export const GRPC_STATUS: Readonly<Record<number, string>> = {
  0: "OK",
  1: "CANCELLED",
  2: "UNKNOWN",
  3: "INVALID_ARGUMENT",
  4: "DEADLINE_EXCEEDED",
  5: "NOT_FOUND",
  6: "ALREADY_EXISTS",
  7: "PERMISSION_DENIED",
  8: "RESOURCE_EXHAUSTED",
  9: "FAILED_PRECONDITION",
  10: "ABORTED",
  11: "OUT_OF_RANGE",
  12: "UNIMPLEMENTED",
  13: "INTERNAL",
  14: "UNAVAILABLE",
  15: "DATA_LOSS",
  16: "UNAUTHENTICATED",
};

/** What the wire said about a failure, for the `unknownError` fallback. */
export interface GrpcErrorInfo {
  /** HTTP status of the response. */
  readonly status: number;
  /** Numeric gRPC status when the server supplied one. */
  readonly grpcStatus?: number | undefined;
  /** Canonical gRPC status name (e.g. `UNAUTHENTICATED`) when known. */
  readonly grpcStatusName?: string | undefined;
  /** Decoded `grpc-message` (percent-unescaped). */
  readonly message: string;
  readonly headers: Record<string, string | undefined>;
}

export interface GrpcProtocolOptions<C> {
  /**
   * Resolve credentials ON THE CALLING FIBER — evaluated per request, never
   * at layer build time (see `RestProtocolOptions.credentials`). Its
   * error/requirement channels are erased at the protocol boundary and
   * reintroduced by the generated `<Sdk>OpError` / `<Sdk>OpContext`
   * annotations.
   */
  readonly credentials: Effect.Effect<C, any, any>;
  /** API base URL from the resolved credentials. */
  readonly baseUrl: (credentials: C) => string;
  /** Static per-request headers (client type/version, …). */
  readonly headers: (credentials: C) => Record<string, string>;
  /**
   * Extra per-request headers resolved on the calling fiber (e.g. an
   * auth-token exchange). Receives the resolved credentials, the op's gRPC
   * path, and the request input so bootstrap RPCs can opt out of token
   * lookup and per-target credentials can key off request fields.
   */
  readonly authenticate?: (args: {
    readonly credentials: C;
    readonly path: string;
    readonly input: unknown;
  }) => Effect.Effect<Record<string, string>, any, any>;
  /**
   * Optional per-request endpoint routing — resolved on the calling fiber
   * before `authenticate`. Returning `{ baseUrl }` overrides
   * `options.baseUrl` for this request (e.g. a data-plane address carried
   * in credentials or looked up from a request field); `headers` are merged
   * beneath the `authenticate` result so auth can still override them.
   */
  readonly route?: (args: {
    readonly credentials: C;
    readonly path: string;
    readonly input: unknown;
  }) => Effect.Effect<
    | {
        readonly baseUrl?: string;
        readonly headers?: Record<string, string>;
      }
    | undefined,
    any,
    any
  >;
  /** Fallback error for nonzero gRPC status / malformed responses. */
  readonly unknownError: (info: GrpcErrorInfo) => unknown;
}

/** `grpc-message` is percent-encoded per the gRPC-over-HTTP/2 spec. */
export const decodeGrpcMessage = (
  raw: string | undefined,
): string | undefined => {
  if (raw === undefined) return undefined;
  try {
    return decodeURIComponent(raw.replace(/\+/g, "%20"));
  } catch {
    return raw;
  }
};

/**
 * Wrap a protobuf message in one uncompressed gRPC frame:
 * `0x00 | u32be(length) | payload`.
 */
export const grpcFrame = (payload: Uint8Array): Uint8Array => {
  const frame = new Uint8Array(5 + payload.length);
  new DataView(frame.buffer).setUint32(1, payload.length);
  frame.set(payload, 5);
  return frame;
};

/**
 * Extract the first message frame (`flag 0x00`) from a gRPC response body,
 * skipping trailer frames (`flag 0x80`). Returns `undefined` when the body
 * holds no message frame (trailers-only or empty).
 */
export const readMessageFrame = (buf: Uint8Array): Uint8Array | undefined => {
  const r = new Reader(buf);
  while (r.pos + 5 <= r.end) {
    const flag = r.buf[r.pos++]!;
    const len = new DataView(
      r.buf.buffer,
      r.buf.byteOffset + r.pos,
      4,
    ).getUint32(0);
    r.pos += 4;
    if (r.pos + len > r.end) return undefined;
    const payload = r.buf.subarray(r.pos, r.pos + len);
    r.pos += len;
    if (flag === 0) return payload;
    // flag & 0x80 → trailers frame: parsed for position only.
  }
  return undefined;
};

// Bridge: Protocol.decode is typed as Effect<unknown> (no error channel),
// but gRPC failures are real typed errors that operations re-surface via
// their `errors: [...]` lists. Same convention as protocol-rest's `fail`.
const fail = (e: unknown): Effect.Effect<never> =>
  Effect.fail(e) as Effect.Effect<never>;

/**
 * Build a `Layer<Protocol>` for a unary `application/grpc` API. Assign the
 * result to a module-level const in the provider's `protocol.ts` —
 * `API.make` memoizes protocol layers by value identity.
 */
export const makeGrpcProtocol = <C>(
  options: GrpcProtocolOptions<C>,
): Layer.Layer<API.Protocol> => {
  const encode = ({
    input,
    inputAst,
  }: {
    readonly input: unknown;
    readonly inputAst: AST.AST;
    readonly config: API.ProtocolOperationConfig;
  }) =>
    Effect.gen(function* () {
      const creds = yield* options.credentials as Effect.Effect<C>;
      const http = getAnn(inputAst, httpSymbol) as HttpTrait | undefined;
      if (http?.uri === undefined) {
        return yield* fail(
          new Error(
            "grpc protocol requires the input schema to carry T.Http (the gRPC method path)",
          ),
        );
      }
      const path = http.uri;
      const routed =
        options.route !== undefined
          ? yield* options.route({ credentials: creds, path, input })
          : undefined;
      const authHeaders =
        options.authenticate !== undefined
          ? yield* options.authenticate({ credentials: creds, path, input })
          : {};
      const payload = encodeMessage(inputAst, unwrapRedactedDeep(input));
      return HttpClientRequest.post(
        `${routed?.baseUrl ?? options.baseUrl(creds)}${path}`,
      ).pipe(
        HttpClientRequest.bodyUint8Array(grpcFrame(payload)),
        HttpClientRequest.setHeaders({
          "content-type": "application/grpc",
          accept: "application/grpc",
          te: "trailers",
          ...options.headers(creds),
          ...routed?.headers,
          ...authHeaders,
        }),
      );
    });

  /** Parse the gRPC status/message headers and build the wireError factory. */
  const responseStatus = (
    response: HttpClientResponse.HttpClientResponse,
  ): {
    readonly grpcStatus: number | undefined;
    readonly message: string;
    readonly headers: Record<string, string | undefined>;
    readonly wireError: (extra?: Partial<GrpcErrorInfo>) => unknown;
  } => {
    const headers = response.headers as Record<string, string | undefined>;
    const grpcStatusRaw = headers["grpc-status"];
    const grpcStatus =
      grpcStatusRaw !== undefined && /^\d+$/.test(grpcStatusRaw)
        ? Number(grpcStatusRaw)
        : undefined;
    const message =
      decodeGrpcMessage(headers["grpc-message"]) ??
      `gRPC status ${grpcStatusRaw ?? "?"}`;
    const wireError = (extra?: Partial<GrpcErrorInfo>) =>
      options.unknownError({
        status: response.status,
        grpcStatus,
        grpcStatusName:
          grpcStatus !== undefined ? GRPC_STATUS[grpcStatus] : undefined,
        message,
        headers,
        ...extra,
      });
    return { grpcStatus, message, headers, wireError };
  };

  const decode = ({
    response,
    outputAst,
  }: {
    readonly response: HttpClientResponse.HttpClientResponse;
    readonly outputAst: AST.AST;
    readonly errors: ReadonlyArray<unknown>;
    readonly config: API.ProtocolOperationConfig;
  }) =>
    Effect.gen(function* () {
      const buf = new Uint8Array(
        yield* response.arrayBuffer.pipe(Effect.orDie),
      );
      const { grpcStatus, message, wireError } = responseStatus(response);
      const grpcStatusRaw = (
        response.headers as Record<string, string | undefined>
      )["grpc-status"];

      if (debugHttp()) {
        console.error(
          `[distilled] <- ${response.status} grpc=${grpcStatusRaw} bytes=${buf.length}`,
        );
      }

      if (grpcStatus !== undefined && grpcStatus !== 0) {
        return yield* fail(wireError());
      }

      const payload = readMessageFrame(buf);
      if (payload === undefined) {
        // No message frame: tolerate when the server said OK (empty
        // message bodies decode to `{}`) or the body is genuinely empty.
        if (grpcStatus === 0 || buf.length === 0) {
          return wrapSensitive(outputAst, {});
        }
        // HTTP-level failure with no gRPC status (gateway errors etc.).
        return yield* fail(
          wireError({
            message:
              response.status >= 400 ? `HTTP ${response.status}` : message,
          }),
        );
      }

      return wrapSensitive(outputAst, decodeMessage(outputAst, payload));
    });

  /**
   * Incremental gRPC frame splitter over a response body stream: message
   * frames (`flag 0x00`) become elements; trailer frames (`flag 0x80`) carry
   * `key: value\r\n` header blocks whose `grpc-status`/`grpc-message` are
   * surfaced when nonzero. Fetch cannot see real HTTP/2 trailers, so a
   * clean body EOF is treated as end-of-stream; an envoy that emits
   * trailers as a body frame still has its status honored.
   */
  const decodeStream: NonNullable<API.Protocol["Service"]["decodeStream"]> = ({
    response,
    outputAst,
  }) => {
    const { grpcStatus, wireError } = responseStatus(response);
    if (grpcStatus !== undefined && grpcStatus !== 0) {
      return Stream.fail(wireError());
    }
    if (response.status >= 400 && grpcStatus === undefined) {
      return Stream.fail(wireError({ message: `HTTP ${response.status}` }));
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
        } else if ((flag & 0x80) !== 0) {
          const status = parseTrailerStatus(payload);
          if (status !== undefined && status.code !== 0) {
            terminalError = wireError({
              grpcStatus: status.code,
              grpcStatusName: GRPC_STATUS[status.code],
              message: status.message ?? `gRPC status ${status.code}`,
            });
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
      // A nonzero status from a trailer frame fails the stream's tail —
      // evaluated lazily so `terminalError` is set by the time this runs.
      Stream.suspend(() =>
        terminalError !== undefined ? Stream.fail(terminalError) : Stream.empty,
      ),
    );
  };

  return Layer.succeed(
    API.Protocol,
    API.Protocol.of({
      encode: (args) =>
        encode(args) as Effect.Effect<HttpClientRequest.HttpClientRequest>,
      decode,
      decodeStream,
    }),
  );
};

/** Parse a gRPC trailer frame's `key: value` block for status + message. */
const parseTrailerStatus = (
  payload: Uint8Array,
): { code: number; message?: string | undefined } | undefined => {
  let code: number | undefined;
  let message: string | undefined;
  for (const line of new TextDecoder().decode(payload).split("\r\n")) {
    const sep = line.indexOf(":");
    if (sep <= 0) continue;
    const key = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();
    if (key === "grpc-status" && /^\d+$/.test(value)) code = Number(value);
    if (key === "grpc-message") message = decodeGrpcMessage(value);
  }
  return code === undefined ? undefined : { code, message };
};
