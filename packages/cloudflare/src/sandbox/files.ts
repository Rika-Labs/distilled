/**
 * Sandbox file operations — hand-written.
 *
 * `GET|PUT /v1/sandbox/{id}/file/{path}` uses media types the pipeline
 * cannot express (`application/octet-stream` both ways) AND a routing quirk
 * generic label substitution would break: the bridge routes
 * `app.get("…/file/*")` and slices `c.req.path` — the undecoded pathname —
 * after the literal `/file/` marker, so the path rides as the raw URL
 * suffix (slashes verbatim, never percent-encoded). `SandboxBridgeProtocol`
 * builds these URLs by hand; the `T.Http` annotations below document the
 * route for introspection but are not what encodes the request.
 *
 * Semantics (from the bridge implementation):
 *   - paths must resolve under `/workspace` after normalization — anything
 *     escaping it is a 403 `invalid_request`;
 *   - reads return raw bytes (404 `workspace_read_not_found` when absent);
 *   - writes are whole-file `application/octet-stream` bodies, capped at
 *     32 MiB server-side (413 `payload_too_large`), and answer `{ok: true}`;
 *   - both honor the optional `Session-Id` header.
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

export interface ReadSandboxFileRequest {
  /** Sandbox id (`[a-z2-7]{1,128}` — the Durable Object key). */
  readonly id: string;
  /**
   * Path inside the sandbox; a leading `/` is accepted and stripped — the
   * worker resolves `/${path}` under `/workspace` either way.
   */
  readonly path: string;
  /** Execution session id; rides as the `Session-Id` header. */
  readonly sessionId?: string;
}

export const ReadSandboxFileRequest = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    id: S.String.pipe(T.Label("id")),
    path: S.String,
    sessionId: S.optional(S.String.pipe(T.Header("Session-Id"))),
  }).pipe(
    T.Http({
      method: "GET",
      uri: "/v1/sandbox/{id}/file/{path}",
      code: 200,
    }),
  ),
).annotate({
  identifier: "ReadSandboxFileRequest",
}) as any as S.Schema<ReadSandboxFileRequest>;

export type ReadSandboxFileError = SandboxBridgeOpError;

/** Read a whole file as bytes (the response body IS the file). */
export const readSandboxFile: API.OperationMethod<
  ReadSandboxFileRequest,
  Uint8Array,
  ReadSandboxFileError,
  SandboxBridgeOpContext
> = /*@__PURE__*/ API.make(() => ({
  input: ReadSandboxFileRequest,
  output: S.Uint8Array,
  errors: [UnknownCloudflareSandboxError],
  protocol: SandboxBridgeProtocol,
  retry: Retry.Retry,
  operationName: "readSandboxFile",
}));

export interface WriteSandboxFileRequest {
  readonly id: string;
  /** Same path rules as {@link ReadSandboxFileRequest.path}. */
  readonly path: string;
  /** Whole file content — the bridge enforces a 32 MiB limit. */
  readonly data: Uint8Array;
  readonly sessionId?: string;
}

export const WriteSandboxFileRequest = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    id: S.String.pipe(T.Label("id")),
    path: S.String,
    data: S.Uint8Array,
    sessionId: S.optional(S.String.pipe(T.Header("Session-Id"))),
  }).pipe(
    T.Http({
      method: "PUT",
      uri: "/v1/sandbox/{id}/file/{path}",
      code: 200,
    }),
  ),
).annotate({
  identifier: "WriteSandboxFileRequest",
}) as any as S.Schema<WriteSandboxFileRequest>;

export interface WriteSandboxFileResponse {
  readonly ok?: boolean;
}

export const WriteSandboxFileResponse = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    ok: S.optional(S.Boolean.pipe(T.Body("ok"))),
  }),
).annotate({
  identifier: "WriteSandboxFileResponse",
}) as any as S.Schema<WriteSandboxFileResponse>;

export type WriteSandboxFileError = SandboxBridgeOpError;

/** Write a whole file (non-atomic; one `application/octet-stream` body). */
export const writeSandboxFile: API.OperationMethod<
  WriteSandboxFileRequest,
  WriteSandboxFileResponse,
  WriteSandboxFileError,
  SandboxBridgeOpContext
> = /*@__PURE__*/ API.make(() => ({
  input: WriteSandboxFileRequest,
  output: WriteSandboxFileResponse,
  errors: [UnknownCloudflareSandboxError],
  protocol: SandboxBridgeProtocol,
  retry: Retry.Retry,
  operationName: "writeSandboxFile",
}));
