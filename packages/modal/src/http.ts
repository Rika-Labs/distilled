/**
 * Transport split for Modal.
 *
 * The control plane (`api.modal.com`) accepts unary `application/grpc`
 * POSTs over HTTP/1.1 `fetch`. Task command routers (`*.w.modal.host`)
 * are HTTP/2-only and serve a ZeroSSL chain that Bun's `fetch` TLS stack
 * cannot verify — so router URLs go over `node:http2`, which negotiates h2
 * and verifies the chain correctly under both Node and Bun.
 *
 * h2 responses carry `grpc-status` in trailers, which `fetch`-style
 * response objects cannot represent; trailers are synthesized into
 * gRPC-web-style `0x80` body frames so `Protocol.decodeStream` surfaces
 * the terminal status identically on both transports.
 *
 * `node:http2` is loaded lazily through a computed specifier: published
 * builds ship with `types: []` (no `@types/node`), so the module must not
 * appear in a statically resolved import. The structural interfaces below
 * declare only the h2 surface this client uses; runtimes without
 * `node:http2` (browsers, edge workers) simply fail router requests.
 */
import { Effect } from "effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

type Http2Listener = (arg: unknown) => void;

/** Minimal structural surface of `node:http2`'s ClientHttp2Stream. */
interface Http2StreamLike {
  readonly destroyed: boolean;
  on(event: string, listener: Http2Listener): void;
  once(event: string, listener: Http2Listener): void;
  close(code?: number): void;
  end(body?: Uint8Array): void;
}

/** Minimal structural surface of `node:http2`'s ClientHttp2Session. */
interface Http2SessionLike {
  readonly destroyed: boolean;
  readonly closed: boolean;
  readonly socket?: { unref(): void; destroy?(): void } | undefined;
  request(headers: Record<string, string>): Http2StreamLike;
  on(event: string, listener: Http2Listener): void;
  once(event: string, listener: Http2Listener): void;
  unref?(): void;
  destroy?(): void;
  close(): void;
}

/** Minimal structural surface of the `node:http2` module. */
interface Http2ModuleLike {
  connect(authority: string): Http2SessionLike;
  constants: { readonly NGHTTP2_CANCEL: number };
}

let http2Module: Promise<Http2ModuleLike> | undefined;

const importHttp2 = (): Promise<Http2ModuleLike> =>
  // The specifier is deliberately non-literal: a literal `import("node:http2")`
  // would typecheck against `@types/node`, which publish builds exclude.
  (import("node:" + "http2") as Promise<unknown>).then(
    (mod) => mod as Http2ModuleLike,
  );

const loadHttp2 = (
  request: HttpClientRequest.HttpClientRequest,
): Effect.Effect<Http2ModuleLike, HttpClientError.HttpClientError> =>
  Effect.tryPromise({
    try: () => (http2Module ??= importHttp2()),
    catch: (cause) => transportError(request, cause),
  });

/** Command routers live under per-task `*.w.modal.host` origins. */
const isRouterUrl = (url: URL): boolean =>
  url.hostname === "w.modal.host" || url.hostname.endsWith(".w.modal.host");

const sessions = new Map<string, Http2SessionLike>();
const activeStreams = new Map<Http2SessionLike, number>();

/**
 * Bun's `node:http2` compat refs the session natively and its `unref()` is
 * a stub — an idle pooled session holds the process open forever. There a
 * session is destroyed when its last stream closes; elsewhere `unref`
 * keeps idle pooling from blocking exit.
 */
const unrefIsEffective = !("Bun" in globalThis);

const unrefSession = (session: Http2SessionLike): void => {
  try {
    session.unref?.();
  } catch {
    // unref unsupported
  }
  // `session.socket` is a getter that throws on some compat builds once
  // connected (`ERR_HTTP2_NO_SOCKET_MANIPULATION`), so it must be probed
  // inside try/catch rather than optional-chained.
  try {
    session.socket?.unref();
  } catch {
    // socket hidden or already unref'd
  }
};

const destroySession = (origin: string, session: Http2SessionLike): void => {
  sessions.delete(origin);
  activeStreams.delete(session);
  if (session.destroyed) return;
  // `close()` only performs the GOAWAY handshake — under Bun's compat
  // layer the socket stays established waiting on the peer. `destroy()`
  // tears the session and socket down immediately.
  try {
    if (session.destroy !== undefined) {
      session.destroy();
    } else {
      session.close();
    }
  } catch {
    // already closing
  }
  try {
    session.socket?.destroy?.();
  } catch {
    // already destroyed
  }
};

const trackStream = (
  session: Http2SessionLike,
  origin: string,
  stream: Http2StreamLike,
): void => {
  activeStreams.set(session, (activeStreams.get(session) ?? 0) + 1);
  let released = false;
  // `close` is the canonical end-of-stream signal, but Bun's compat layer
  // does not emit it for streams the server leaves half-closed — `end`
  // (remote END_STREAM), `error`, `aborted`, and `frameError` cover the
  // observable terminal states.
  const release = () => {
    if (released) return;
    released = true;
    const remaining = (activeStreams.get(session) ?? 1) - 1;
    if (remaining > 0) {
      activeStreams.set(session, remaining);
      return;
    }
    activeStreams.delete(session);
    if (!unrefIsEffective) {
      destroySession(origin, session);
    }
  };
  stream.once("end", release);
  stream.once("close", release);
  stream.once("error", release);
  stream.once("aborted", release);
  stream.once("frameError", release);
};

const sessionFor = (
  http2: Http2ModuleLike,
  origin: string,
): Http2SessionLike => {
  const cached = sessions.get(origin);
  if (cached !== undefined && !cached.destroyed && !cached.closed) {
    return cached;
  }
  const session = http2.connect(origin);
  unrefSession(session);
  session.once("connect", () => unrefSession(session));
  const drop = () => destroySession(origin, session);
  session.on("error", drop);
  session.on("goaway", drop);
  session.on("close", drop);
  sessions.set(origin, session);
  return session;
};

/** Close every pooled router session (sandbox teardown / client close). */
export const closeRouterSessions = (): void => {
  for (const [origin, session] of sessions) {
    destroySession(origin, session);
  }
  sessions.clear();
};

/** Pseudo/connection headers h2 forbids on requests. */
const H2_FORBIDDEN = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "host",
]);

const requestBody = (
  body: HttpClientRequest.HttpClientRequest["body"],
): Uint8Array | undefined =>
  body._tag === "Uint8Array" ? body.body : undefined;

const transportError = (
  request: HttpClientRequest.HttpClientRequest,
  cause: unknown,
): HttpClientError.HttpClientError =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({ request, cause }),
  });

/**
 * Encode h2 trailers as a `0x80`-flagged gRPC frame so the generic
 * decodeStream/unary trailer scan sees `grpc-status`/`grpc-message`.
 */
const trailerFrame = (trailers: Record<string, unknown>): Uint8Array => {
  const lines =
    Object.entries(trailers)
      .filter(([k]) => !k.startsWith(":"))
      .map(([k, v]) => `${k}: ${v}`)
      .join("\r\n") + "\r\n";
  const payload = new TextEncoder().encode(lines);
  const frame = new Uint8Array(5 + payload.length);
  frame[0] = 0x80;
  new DataView(frame.buffer).setUint32(1, payload.length);
  frame.set(payload, 5);
  return frame;
};

const executeHttp2 = (
  request: HttpClientRequest.HttpClientRequest,
  url: URL,
  outerSignal: AbortSignal,
): Effect.Effect<
  HttpClientResponse.HttpClientResponse,
  HttpClientError.HttpClientError
> =>
  Effect.flatMap(loadHttp2(request), (http2) =>
    Effect.callback<
      HttpClientResponse.HttpClientResponse,
      HttpClientError.HttpClientError
    >((resume, signal) => {
      let stream: Http2StreamLike;
      try {
        const headers: Record<string, string> = {
          ":method": request.method,
          ":path": url.pathname + url.search,
        };
        for (const [name, value] of Object.entries(request.headers)) {
          if (!H2_FORBIDDEN.has(name.toLowerCase())) headers[name] = value;
        }
        const session = sessionFor(http2, url.origin);
        unrefSession(session);
        stream = session.request(headers);
        trackStream(session, url.origin, stream);
      } catch (cause) {
        resume(Effect.fail(transportError(request, cause)));
        return;
      }

      const onAbort = () => stream.close(http2.constants.NGHTTP2_CANCEL);
      signal.addEventListener("abort", onAbort);
      outerSignal.addEventListener("abort", onAbort);

      stream.once("response", (responseHeadersArg) => {
        const responseHeaders = (responseHeadersArg ?? {}) as Record<
          string,
          unknown
        >;
        const status = Number(responseHeaders[":status"] ?? 0);
        const headerInit: Record<string, string> = {};
        for (const [name, value] of Object.entries(responseHeaders)) {
          if (!name.startsWith(":") && value !== undefined) {
            headerInit[name] = String(value);
          }
        }
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            stream.on("data", (chunk) =>
              controller.enqueue(new Uint8Array(chunk as ArrayBuffer)),
            );
            stream.on("trailers", (trailers) => {
              try {
                controller.enqueue(
                  trailerFrame((trailers ?? {}) as Record<string, unknown>),
                );
              } catch {
                // controller already closed
              }
            });
            stream.once("end", () => {
              try {
                controller.close();
              } catch {
                // already closed
              }
            });
            stream.once("error", (cause) => controller.error(cause));
          },
        });
        resume(
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(body, { status, headers: headerInit }),
            ),
          ),
        );
      });
      stream.once("error", (cause) =>
        resume(Effect.fail(transportError(request, cause))),
      );
      stream.end(requestBody(request.body));

      return Effect.sync(() => {
        signal.removeEventListener("abort", onAbort);
        outerSignal.removeEventListener("abort", onAbort);
        if (!stream.destroyed) stream.close();
      });
    }),
  );

/**
 * `HttpClient` layer for Modal: `*.w.modal.host` over `node:http2`,
 * everything else over the ambient `fetch` client.
 */
export const ModalHttpClient: Layer.Layer<HttpClient.HttpClient> = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const fetchClient = yield* HttpClient.HttpClient;
    return HttpClient.make((request, url, signal) =>
      isRouterUrl(url)
        ? executeHttp2(request, url, signal)
        : fetchClient.execute(request),
    );
  }),
).pipe(Layer.provide(FetchHttpClient.layer));
