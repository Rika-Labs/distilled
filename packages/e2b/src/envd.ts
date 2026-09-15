/**
 * envd — the per-sandbox half of E2B.
 *
 * Every sandbox runs envd: a REST surface for file content + env vars +
 * health, and Connect-RPC `Process`/`Filesystem` services for execution,
 * stdio streams, signals, and directory watchers. All of it is addressed
 * per-sandbox and authenticated per-sandbox, which is why the connection
 * is a context service rather than part of `Credentials`:
 *
 *   EnvdConnection   `{ baseUrl, headers, sandboxId, envdVersion? }` —
 *                    resolved inside encode on the calling fiber, so the
 *                    adapter can provide a different connection per sandbox
 *                    handle.
 *
 *   connectionLayer  builds an EnvdConnection layer from a sandbox's
 *                    identity + access token (the `envdAccessToken` /
 *                    `domain` / `envdVersion` fields a create/connect/info
 *                    response carries).
 *
 * Base-URL rule (the official SDK's): on E2B's hosted domains envd sits
 * behind the shared `https://sandbox.<domain>` ingress, routed by the
 * `E2b-Sandbox-Id` / `E2b-Sandbox-Port` request headers; on any other
 * domain it answers directly at `https://<envdPort>-<sandboxId>.<domain>`.
 *
 * The facade helpers (`runProcess`, `startProcess`, `watchDir`) own the
 * ProcessEvent/WatchDir event-shape knowledge — callers get folded results
 * or typed streams, never raw wire frames.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type * as HttpClient from "effect/unstable/http/HttpClient";

import * as Services from "./services/index.ts";

/** envd listens on this port inside every sandbox. */
export const ENVD_PORT = 49983;

/**
 * Domains whose `sandbox.<domain>` ingress fronts envd (the official SDK's
 * `supportedDomains`). Any other domain uses the direct `<port>-<id>` host
 * form (self-hosted / custom domains).
 */
const HOSTED_DOMAINS: ReadonlySet<string> = new Set([
  "e2b.app",
  "e2b.dev",
  "e2b.pro",
  "e2b-staging.dev",
]);

/** The envd default user (used when the RPC wants basic-auth user context). */
export const DEFAULT_USER = "user";

export interface EnvdConnectionValue {
  /** Absolute envd base URL (no trailing slash), e.g. `https://sandbox.e2b.dev`. */
  readonly baseUrl: string;
  /**
   * Headers applied to every envd request for this sandbox — routing
   * (`E2b-Sandbox-Id`/`E2b-Sandbox-Port`) and auth (`X-Access-Token`).
   * Facade helpers merge per-call additions (basic-auth user, keepalive
   * interval, RPC deadlines) on top.
   */
  readonly headers: Record<string, string>;
  readonly sandboxId: string;
  readonly envdVersion: string | undefined;
}

/**
 * Per-sandbox envd binding. envd operations resolve it on the calling fiber
 * inside encode, so `Effect.provideService(EnvdConnection, conn)` scopes a
 * call to one sandbox.
 */
export class EnvdConnection extends Context.Service<
  EnvdConnection,
  EnvdConnectionValue
>()("E2BEnvdConnection") {}

/** The envd base URL for a sandbox (hosted-ingress vs direct-port form). */
export const envdBaseUrl = (args: {
  readonly sandboxId: string;
  readonly domain: string;
  readonly envdPort?: number;
}): string =>
  HOSTED_DOMAINS.has(args.domain)
    ? `https://sandbox.${args.domain}`
    : `https://${args.envdPort ?? ENVD_PORT}-${args.sandboxId}.${args.domain}`;

/**
 * `-1 | 0 | 1` semver-ish comparison for envd version gates (the official
 * SDK's `compareVersions` usage: user basic-auth below `0.4.0`, octet-stream
 * upload below `0.5.x`, closeStdin below `1.x` — callers gate on it).
 */
export const compareVersions = (a: string, b: string): number => {
  const pa = a.split(".").map((s) => Number.parseInt(s, 10) || 0);
  const pb = b.split(".").map((s) => Number.parseInt(s, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
};

/**
 * envd's per-RPC user header: `Authorization: Basic base64("<user>:")`.
 * The official SDK sends it whenever a user is named, and defaults to the
 * envd default user on envd < 0.4.0 (which required it for process start).
 */
export const basicAuthHeader = (
  envdVersion: string | undefined,
  user: string | undefined,
): Record<string, string> => {
  const u =
    user ??
    (envdVersion !== undefined && compareVersions(envdVersion, "0.4.0") < 0
      ? DEFAULT_USER
      : undefined);
  if (u === undefined) return {};
  const encoded = Encoding.encodeBase64(`${u}:`);
  return { authorization: `Basic ${encoded}` };
};

/** Build an `EnvdConnectionValue` from a sandbox's binding fields. */
export const makeConnection = (args: {
  readonly sandboxId: string;
  readonly domain: string;
  readonly accessToken?: string | undefined;
  readonly envdVersion?: string | undefined;
  readonly envdPort?: number;
  /** Extra headers merged over the routing/auth defaults. */
  readonly headers?: Record<string, string>;
}): EnvdConnectionValue => ({
  baseUrl: envdBaseUrl({
    sandboxId: args.sandboxId,
    domain: args.domain,
    envdPort: args.envdPort,
  }),
  headers: {
    "e2b-sandbox-id": args.sandboxId,
    "e2b-sandbox-port": String(args.envdPort ?? ENVD_PORT),
    ...(args.accessToken !== undefined
      ? { "x-access-token": args.accessToken }
      : {}),
    ...args.headers,
  },
  sandboxId: args.sandboxId,
  envdVersion: args.envdVersion,
});

/** `EnvdConnection` as a layer — provide around envd-bound effects/streams. */
export const connectionLayer = (
  args: Parameters<typeof makeConnection>[0],
): Layer.Layer<EnvdConnection> =>
  Layer.succeed(EnvdConnection, makeConnection(args));

/**
 * Merge per-call headers into the ambient connection (facade helper): user
 * basic-auth, streaming keepalive, and Connect RPC deadlines ride the
 * request without mutating the caller's connection value.
 */
const withHeaders = <A, E, R>(
  extra: Record<string, string>,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | EnvdConnection> =>
  Effect.flatMap(EnvdConnection, (conn) =>
    Effect.provideService(effect, EnvdConnection, {
      ...conn,
      headers: { ...conn.headers, ...extra },
    }),
  );

const withStreamHeaders = <A, E, R>(
  extra: Record<string, string>,
  stream: Stream.Stream<A, E, R>,
): Stream.Stream<A, E, R | EnvdConnection> =>
  Stream.unwrap(
    Effect.map(EnvdConnection, (conn) =>
      Stream.provideService(stream, EnvdConnection, {
        ...conn,
        headers: { ...conn.headers, ...extra },
      }),
    ),
  );

// =============================================================================
// Process facade
// =============================================================================

/**
 * The flattened ProcessEvent shape (proto3 oneofs decode flat): exactly one
 * of `start`/`data`/`end`/`keepalive` is present per event; `data` carries
 * one of `stdout`/`stderr`/`pty`.
 */
export interface ProcessEvent {
  readonly start?: { readonly pid?: number };
  readonly data?: {
    readonly stdout?: Uint8Array;
    readonly stderr?: Uint8Array;
    readonly pty?: Uint8Array;
  };
  readonly end?: {
    readonly exitCode?: number;
    readonly exited?: boolean;
    readonly status?: string;
    readonly error?: string;
  };
  readonly keepalive?: {};
}

export interface ProcessRunResult {
  /** -1 when the stream ended before a start event (shouldn't happen). */
  readonly pid: number;
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  /** PTY output when the process was started with a pty. */
  readonly pty: Uint8Array;
  /** envd's `EndEvent.error`, when the process failed to run. */
  readonly error: string | undefined;
}

const concatBytes = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
};

/**
 * The wire carries proto `bytes` fields as base64 strings (the protobuf
 * codec's TS surface); the facade's `ProcessEvent` promises real bytes.
 * Decode each data member — pass-through on an already-decoded value keeps
 * the fold tolerant of hand-built events.
 */
const bytesIn = (v: string | Uint8Array): Uint8Array => {
  if (v instanceof Uint8Array) return v;
  const r = Encoding.decodeBase64(v);
  return r._tag === "Success" ? r.success : new Uint8Array(0);
};

/** Wire `bytes` fields go out base64 — the generated `string` surface. */
const bytesOut = (v: Uint8Array): string => Encoding.encodeBase64(v);

/** Generated (base64) ProcessEvent → facade (Uint8Array) ProcessEvent. */
const decodeProcessEvent = (
  ev: Services.process.ProcessEvent,
): ProcessEvent => ({
  ...(ev.start !== undefined ? { start: ev.start } : {}),
  ...(ev.data !== undefined
    ? {
        data: {
          ...(ev.data.stdout !== undefined
            ? { stdout: bytesIn(ev.data.stdout) }
            : {}),
          ...(ev.data.stderr !== undefined
            ? { stderr: bytesIn(ev.data.stderr) }
            : {}),
          ...(ev.data.pty !== undefined ? { pty: bytesIn(ev.data.pty) } : {}),
        },
      }
    : {}),
  ...(ev.end !== undefined ? { end: ev.end } : {}),
  ...(ev.keepalive !== undefined ? { keepalive: {} } : {}),
});

const decodeEvents = <E, R>(
  events: Stream.Stream<
    { readonly event?: Services.process.ProcessEvent | undefined },
    E,
    R
  >,
): Stream.Stream<{ readonly event?: ProcessEvent | undefined }, E, R> =>
  Stream.map(events, (msg) =>
    msg.event === undefined ? {} : { event: decodeProcessEvent(msg.event) },
  );

/**
 * Fold a `ProcessEvent` stream into a run result: captures the pid from the
 * start event, concatenates stdout/stderr/pty data frames, and takes the
 * exit code + error off the end event. A stream that ends with no end event
 * reports `exited: false` upstream semantics as exitCode -1 — callers that
 * need certainty should watch `EndEvent.exited` via `startProcess` instead.
 */
export const collectProcessEvents = <E, R>(
  events: Stream.Stream<{ readonly event?: ProcessEvent | undefined }, E, R>,
): Effect.Effect<ProcessRunResult, E, R> =>
  Stream.runFold(
    events,
    () => ({
      pid: -1,
      exitCode: -1,
      error: undefined as string | undefined,
      out: [] as Array<Uint8Array>,
      err: [] as Array<Uint8Array>,
      pty: [] as Array<Uint8Array>,
    }),
    (acc, msg) => {
      const ev = msg.event;
      if (ev === undefined) return acc;
      if (ev.start !== undefined) {
        acc.pid = ev.start.pid ?? -1;
      } else if (ev.data !== undefined) {
        if (ev.data.stdout !== undefined) acc.out.push(ev.data.stdout);
        if (ev.data.stderr !== undefined) acc.err.push(ev.data.stderr);
        if (ev.data.pty !== undefined) acc.pty.push(ev.data.pty);
      } else if (ev.end !== undefined) {
        acc.exitCode = ev.end.exitCode ?? acc.exitCode;
        acc.error = ev.end.error;
      }
      return acc;
    },
  ).pipe(
    Effect.map((acc) => ({
      pid: acc.pid,
      exitCode: acc.exitCode,
      stdout: concatBytes(acc.out),
      stderr: concatBytes(acc.err),
      pty: concatBytes(acc.pty),
      error: acc.error,
    })),
  );

/** Streaming-RPC request headers: envd's keepalive hint + optional deadline. */
const streamHeaders = (
  envdVersion: string | undefined,
  opts: { readonly user?: string; readonly timeoutMs?: number } | undefined,
): Record<string, string> => ({
  "keepalive-ping-interval": "50",
  ...(opts?.timeoutMs !== undefined
    ? { "connect-timeout-ms": String(opts.timeoutMs) }
    : {}),
  ...basicAuthHeader(envdVersion, opts?.user),
});

/**
 * `process.Start` with the official SDK's keepalive + user/deadline headers.
 * Returns the decoded event stream (data frames already base64→bytes) —
 * feed it to `collectProcessEvents` for a `run`-style result, or consume it
 * directly for live output.
 */
export const startProcess = (
  input: Services.process.StartRequest,
  opts?: { readonly user?: string; readonly timeoutMs?: number },
): Stream.Stream<
  { readonly event?: ProcessEvent | undefined },
  Services.process.StartError,
  EnvdConnection | HttpClient.HttpClient
> =>
  Stream.unwrap(
    Effect.map(EnvdConnection, (conn) =>
      withStreamHeaders(
        streamHeaders(conn.envdVersion, opts),
        decodeEvents(
          Services.process.start(input) as Stream.Stream<
            Services.process.StartResponse,
            Services.process.StartError,
            EnvdConnection | HttpClient.HttpClient
          >,
        ),
      ),
    ),
  );

/**
 * `process.Connect` — attach to a running process's event stream by pid or
 * tag (the official SDK's `commands.connect`).
 */
export const connectProcess = (
  input: Services.process.ConnectRequest,
  opts?: { readonly user?: string; readonly timeoutMs?: number },
): Stream.Stream<
  { readonly event?: ProcessEvent | undefined },
  Services.process.ConnectError,
  EnvdConnection | HttpClient.HttpClient
> =>
  Stream.unwrap(
    Effect.map(EnvdConnection, (conn) =>
      withStreamHeaders(
        streamHeaders(conn.envdVersion, opts),
        decodeEvents(
          Services.process.connect(input) as Stream.Stream<
            Services.process.ConnectResponse,
            Services.process.ConnectError,
            EnvdConnection | HttpClient.HttpClient
          >,
        ),
      ),
    ),
  );

/**
 * `commands.run`-shaped helper: start a shell command and collect it to
 * completion. `cmd` becomes `/bin/bash -l -c <cmd>` exactly like the
 * official SDK; `stdin` defaults to false (immediate EOF) — pass `true` to
 * keep stdin open for `sendInput`/`closeStdin` on the returned pid.
 */
export const runCommand = (
  command: string,
  opts?: {
    readonly cwd?: string;
    readonly envs?: Readonly<Record<string, string>>;
    readonly user?: string;
    readonly stdin?: boolean;
    readonly timeoutMs?: number;
  },
): Effect.Effect<
  ProcessRunResult,
  Services.process.StartError,
  EnvdConnection | HttpClient.HttpClient
> =>
  collectProcessEvents(
    startProcess(
      {
        process: {
          cmd: "/bin/bash",
          args: ["-l", "-c", command],
          ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
          ...(opts?.envs !== undefined ? { envs: opts.envs } : {}),
        },
        stdin: opts?.stdin ?? false,
      },
      opts,
    ),
  );

/** Send stdin or pty bytes to a running process (`SendInput` unary RPC). */
export const sendInput = (input: {
  readonly process: Services.process.ProcessSelector;
  readonly data: Uint8Array;
  readonly pty?: boolean;
}): Effect.Effect<
  Services.process.SendInputResponse,
  Services.process.SendInputError,
  EnvdConnection | HttpClient.HttpClient
> =>
  Effect.flatMap(EnvdConnection, (conn) =>
    withHeaders(
      basicAuthHeader(conn.envdVersion, undefined),
      Services.process.sendInput({
        process: input.process,
        input:
          input.pty === true
            ? { pty: bytesOut(input.data) }
            : { stdin: bytesOut(input.data) },
      }),
    ),
  );

/** Signal a process (`SendSignal` — `signal` is the proto enum name). */
export const sendSignal = (input: {
  readonly process: Services.process.ProcessSelector;
  readonly signal: Services.process.Signal;
}): Effect.Effect<
  Services.process.SendSignalResponse,
  Services.process.SendSignalError,
  EnvdConnection | HttpClient.HttpClient
> =>
  Services.process.sendSignal({
    process: input.process,
    signal: input.signal,
  }) as Effect.Effect<
    Services.process.SendSignalResponse,
    Services.process.SendSignalError,
    EnvdConnection | HttpClient.HttpClient
  >;

/** SIGKILL shorthand for the adapter's process kill. */
export const killProcess = (
  process: Services.process.ProcessSelector,
): Effect.Effect<
  Services.process.SendSignalResponse,
  Services.process.SendSignalError,
  EnvdConnection | HttpClient.HttpClient
> => sendSignal({ process, signal: "SIGNAL_SIGKILL" });

/** Close stdin on a non-PTY process (`CloseStdin` unary RPC). */
export const closeStdin = (
  process: Services.process.ProcessSelector,
): Effect.Effect<
  Services.process.CloseStdinResponse,
  Services.process.CloseStdinError,
  EnvdConnection | HttpClient.HttpClient
> =>
  Services.process.closeStdin({ process }) as Effect.Effect<
    Services.process.CloseStdinResponse,
    Services.process.CloseStdinError,
    EnvdConnection | HttpClient.HttpClient
  >;

/** List running processes (`List` unary RPC). */
export const listProcesses = (): Effect.Effect<
  Services.process.ListResponse,
  Services.process.ListError,
  EnvdConnection | HttpClient.HttpClient
> =>
  Services.process.list({}) as Effect.Effect<
    Services.process.ListResponse,
    Services.process.ListError,
    EnvdConnection | HttpClient.HttpClient
  >;

/** Resize a PTY (`Update` unary RPC). */
export const updatePty = (input: {
  readonly process: Services.process.ProcessSelector;
  readonly size: { readonly cols: number; readonly rows: number };
}): Effect.Effect<
  Services.process.UpdateResponse,
  Services.process.UpdateError,
  EnvdConnection | HttpClient.HttpClient
> =>
  Services.process.update({
    process: input.process,
    pty: { size: input.size },
  }) as Effect.Effect<
    Services.process.UpdateResponse,
    Services.process.UpdateError,
    EnvdConnection | HttpClient.HttpClient
  >;

// =============================================================================
// File content (envd REST /files) — owns the Blob/Uint8Array wire shapes
// =============================================================================

/**
 * `POST /files` upload. envd wants the file as a multipart part (`File` |
 * `Blob` on the generated surface); callers pass bytes. `user` becomes the
 * owner (`Authorization: Basic <user>:`) exactly like the official SDK's
 * `files.write`.
 */
export const uploadFile = (input: {
  readonly path: string;
  readonly data: Uint8Array;
  readonly user?: string;
  readonly signature?: string;
  readonly signatureExpiration?: number;
}): Effect.Effect<
  Services.envd.CreateFileResponse,
  Services.envd.CreateFileError,
  EnvdConnection | HttpClient.HttpClient
> =>
  Effect.flatMap(EnvdConnection, (conn) =>
    withHeaders(
      basicAuthHeader(conn.envdVersion, input.user),
      Services.envd.createFile({
        path: input.path,
        file: new Blob([new Uint8Array(input.data)]),
        ...(input.signature !== undefined
          ? { signature: input.signature }
          : {}),
        ...(input.signatureExpiration !== undefined
          ? { signature_expiration: input.signatureExpiration }
          : {}),
      }),
    ),
  );

/**
 * `GET /files` download — returns the raw file bytes (the `T.HttpBody`
 * member the envd protocol fills from `response.arrayBuffer`). `user`
 * scopes filesystem ownership like the official SDK.
 */
export const downloadFile = (input: {
  readonly path: string;
  readonly user?: string;
  readonly signature?: string;
  readonly signatureExpiration?: number;
}): Effect.Effect<
  Uint8Array,
  Services.envd.GetFilesError,
  EnvdConnection | HttpClient.HttpClient
> =>
  Effect.flatMap(EnvdConnection, (conn) =>
    withHeaders(
      basicAuthHeader(conn.envdVersion, input.user),
      Services.envd
        .getFiles({
          path: input.path,
          ...(input.signature !== undefined
            ? { signature: input.signature }
            : {}),
          ...(input.signatureExpiration !== undefined
            ? { signature_expiration: input.signatureExpiration }
            : {}),
        })
        .pipe(Effect.map((r) => r.body)),
    ),
  );

/** `GET /envs` — the sandbox's environment variables. */
export const getEnvs = (): Effect.Effect<
  Services.envd.GetEnvsResponse,
  Services.envd.GetEnvsError,
  EnvdConnection | HttpClient.HttpClient
> =>
  Services.envd.getEnvs({}) as Effect.Effect<
    Services.envd.GetEnvsResponse,
    Services.envd.GetEnvsError,
    EnvdConnection | HttpClient.HttpClient
  >;

/** `GET /health` — envd liveness. */
export const getHealth = (): Effect.Effect<
  Services.envd.GetHealthResponse,
  Services.envd.GetHealthError,
  EnvdConnection | HttpClient.HttpClient
> =>
  Services.envd.getHealth({}) as Effect.Effect<
    Services.envd.GetHealthResponse,
    Services.envd.GetHealthError,
    EnvdConnection | HttpClient.HttpClient
  >;

/**
 * Scope any envd call to a filesystem/process user — merges
 * `Authorization: Basic <user>:` into the ambient connection for the
 * wrapped effect (the official SDK's per-call `user` option). For streams,
 * use {@link withUserStream}.
 */
export const withUser =
  (user: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    withHeaders(basicAuthHeader(undefined, user), effect);

/** Stream counterpart of {@link withUser}. */
export const withUserStream =
  (user: string) =>
  <A, E, R>(stream: Stream.Stream<A, E, R>) =>
    withStreamHeaders(basicAuthHeader(undefined, user), stream);
