/**
 * execSandbox — hand-written streaming operation.
 *
 * `POST /v1/sandbox/{id}/exec` is ordinary REST JSON on the request side
 * (the input schema carries the same `T.Http`/`T.Label`/`T.Body`/`T.Header`
 * annotations generated ops use, so the REST protocol's encode builds the
 * request verbatim — `{argv, timeout_ms?, cwd?}` plus the optional
 * `Session-Id` header). The 200 response is `text/event-stream`, which the
 * pipeline cannot express — `SandboxBridgeProtocol.decodeStream` frames it
 * into `ExecSandboxEvent`s instead:
 *
 *   event: stdout | stderr   data: <base64 chunk>
 *   event: exit              data: {"exit_code": N}      (terminal)
 *   event: error             data: {"error": "…", "code": "…"}  (terminal)
 *
 * The bridge joins `argv` into a single shell command server-side
 * (shell-quoted per element), so this surface is "run a command and stream
 * its output", not a byte-faithful process channel — exit status arrives
 * as the terminal `exit` event, mid-stream failures as `error`.
 */
import * as S from "effect/Schema";
import * as API from "@rikalabs/distilled-core/api";
import * as T from "./traits.ts";
import {
  SandboxBridgeProtocol,
  type SandboxBridgeOpContext,
  type SandboxBridgeOpError,
} from "./protocol.ts";
import { UnknownCloudflareSandboxError } from "./errors.ts";
import * as Retry from "./retry.ts";

export type { SandboxBridgeOpError, SandboxBridgeOpContext };

export interface ExecSandboxRequest {
  /** Sandbox id (`[a-z2-7]{1,128}` — the Durable Object key). */
  readonly id: string;
  /** Non-empty argv; the bridge shell-quotes each element and joins them. */
  readonly argv: ReadonlyArray<string>;
  /** Milliseconds before the command is killed server-side. */
  readonly timeoutMs?: number;
  /** Working directory; must resolve under `/workspace`. */
  readonly cwd?: string;
  /** Execution session id; rides as the `Session-Id` header. */
  readonly sessionId?: string;
}

export const ExecSandboxRequest = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    id: S.String.pipe(T.Label("id")),
    argv: S.Array(S.String).pipe(T.Body("argv")),
    timeoutMs: S.optional(S.Number.pipe(T.Body("timeout_ms"))),
    cwd: S.optional(S.String.pipe(T.Body("cwd"))),
    sessionId: S.optional(S.String.pipe(T.Header("Session-Id"))),
  }).pipe(T.Http({ method: "POST", uri: "/v1/sandbox/{id}/exec", code: 200 })),
).annotate({
  identifier: "ExecSandboxRequest",
}) as any as S.Schema<ExecSandboxRequest>;

/** One decoded frame of the exec SSE stream. */
export type ExecSandboxEvent =
  | { readonly _tag: "stdout"; readonly data: Uint8Array }
  | { readonly _tag: "stderr"; readonly data: Uint8Array }
  | { readonly _tag: "exit"; readonly exitCode: number }
  | {
      readonly _tag: "error";
      readonly error: string;
      readonly code: string | undefined;
    };

export const ExecSandboxEvent = /*@__PURE__*/ S.Union([
  S.Struct({ _tag: S.Literal("stdout"), data: S.Uint8Array }),
  S.Struct({ _tag: S.Literal("stderr"), data: S.Uint8Array }),
  S.Struct({ _tag: S.Literal("exit"), exitCode: S.Number }),
  S.Struct({
    _tag: S.Literal("error"),
    error: S.String,
    code: S.optional(S.String),
  }),
]).annotate({
  identifier: "ExecSandboxEvent",
}) as any as S.Schema<ExecSandboxEvent>;

export type ExecSandboxError = SandboxBridgeOpError;

/**
 * Run `argv` in the named sandbox; returns a bounded Stream of decoded
 * events. The stream ends after the terminal `exit`/`error` frame (the
 * worker closes the SSE response); an HTTP failure surfaces as a typed
 * error before the first element.
 */
export const execSandbox: API.StreamingOperationMethod<
  ExecSandboxRequest,
  ExecSandboxEvent,
  ExecSandboxError,
  SandboxBridgeOpContext
> = /*@__PURE__*/ API.makeStream(() => ({
  input: ExecSandboxRequest,
  output: ExecSandboxEvent,
  errors: [UnknownCloudflareSandboxError],
  protocol: SandboxBridgeProtocol,
  retry: Retry.Retry,
  operationName: "execSandbox",
}));
