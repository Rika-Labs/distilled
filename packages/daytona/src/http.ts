/**
 * Daytona toolbox file transfer — hand-written.
 *
 * The generated `services/toolbox.ts` covers the toolbox JSON surface, but
 * two endpoints carry non-JSON bodies the generic REST decode cannot
 * represent:
 *
 *   GET  /{sandboxId}/files/download    — raw file bytes (Swagger type: file)
 *   POST /{sandboxId}/files/upload-v2   — multipart/form-data upload (the
 *                                         spec's formData params)
 *
 * These helpers use the same routing and auth as generated toolbox ops: the
 * per-sandbox proxy base comes from {@link resolveToolboxUrl} and the
 * Authorization headers from `Credentials`, so callers only need
 * `DaytonaOpContext` in scope. Failures surface as the same error classes a
 * generated op would raise.
 */
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientError from "effect/unstable/http/HttpClientError";
import {
  HTTP_STATUS_MAP,
  InternalServerError,
} from "@rikalabs/distilled-core/errors";
import { parseRetryAfterForStatus } from "@rikalabs/distilled-core/retry-after";
import { Credentials } from "./credentials.ts";
import { UnknownDaytonaError } from "./errors.ts";
import {
  authHeaders,
  resolveToolboxUrl,
  type DaytonaOpContext,
  type DaytonaOpError,
} from "./protocol.ts";

export type { DaytonaOpContext, DaytonaOpError };

/** Non-2xx → the same error class cascade the REST protocol's decode runs. */
const statusMap: Readonly<
  Record<number, (new (args: any) => any) | undefined>
> = HTTP_STATUS_MAP;

const statusError = (
  status: number,
  headers: Record<string, string | undefined>,
  body: string,
): DaytonaOpError => {
  const message = body.trim() ? body.trim().slice(0, 400) : `HTTP ${status}`;
  const StatusErrorClass = statusMap[status];
  if (StatusErrorClass !== undefined) {
    return new StatusErrorClass({
      message,
      retryAfter: parseRetryAfterForStatus(status, headers),
    });
  }
  if (status >= 500) {
    return new InternalServerError({
      message,
      retryAfter: parseRetryAfterForStatus(status, headers),
    });
  }
  return new UnknownDaytonaError({ message, body });
};

const readFailure = (response: {
  readonly status: number;
  readonly headers: Record<string, string | undefined>;
  readonly text: Effect.Effect<string, HttpClientError.HttpClientError>;
}) =>
  Effect.gen(function* () {
    const text = yield* response.text;
    return yield* Effect.fail(
      statusError(response.status, response.headers, text),
    );
  });

/**
 * Download a remote file's raw bytes through the sandbox's toolbox proxy
 * (`GET /{sandboxId}/files/download?path=…`).
 */
export const downloadToolboxFile = (
  sandboxId: string,
  path: string,
): Effect.Effect<Uint8Array, DaytonaOpError, DaytonaOpContext> =>
  Effect.gen(function* () {
    const base = yield* resolveToolboxUrl(sandboxId);
    const resolve = yield* Credentials;
    const creds = yield* resolve;
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.get(`${base}/${sandboxId}/files/download`).pipe(
        HttpClientRequest.setHeaders(authHeaders(creds)),
        HttpClientRequest.setUrlParam("path", path),
      ),
    );
    if (response.status >= 400) {
      return yield* readFailure(response);
    }
    const buffer = yield* response.arrayBuffer;
    return new Uint8Array(buffer);
  });

/**
 * Upload bytes to a remote file through the sandbox's toolbox proxy
 * (`POST /{sandboxId}/files/upload-v2?path=…`, multipart `file` field).
 */
export const uploadToolboxFile = (
  sandboxId: string,
  path: string,
  data: Uint8Array,
): Effect.Effect<void, DaytonaOpError, DaytonaOpContext> =>
  Effect.gen(function* () {
    const base = yield* resolveToolboxUrl(sandboxId);
    const resolve = yield* Credentials;
    const creds = yield* resolve;
    const client = yield* HttpClient.HttpClient;
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(data)]), "file");
    const response = yield* client.execute(
      HttpClientRequest.post(`${base}/${sandboxId}/files/upload-v2`).pipe(
        HttpClientRequest.setHeaders(authHeaders(creds)),
        HttpClientRequest.setUrlParam("path", path),
        HttpClientRequest.bodyFormData(form),
      ),
    );
    if (response.status >= 400) {
      return yield* readFailure(response);
    }
  });
