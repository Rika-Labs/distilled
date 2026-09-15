/**
 * DaytonaProtocol — hand-written.
 *
 * Daytona speaks bearer-authenticated JSON REST across TWO surfaces sharing
 * one protocol layer:
 *
 *   control plane — `apiBaseUrl` (default https://app.daytona.io/api); every
 *                   generated op in `services/api.ts` addresses it directly.
 *
 *   toolbox       — the daemon inside each sandbox, reached through a shared
 *                   proxy at `<toolboxProxyUrl>/<sandboxId>`. Toolbox paths in
 *                   `services/toolbox.ts` are generated as `/{sandboxId}/…`,
 *                   and the `route` hook below redirects them: the proxy base
 *                   is taken from a per-sandbox cache primed from any
 *                   `toolboxProxyUrl` member delivered by the control plane,
 *                   with a `GET /sandbox/{id}/toolbox-proxy-url` lookup as the
 *                   fallback for unprimed ids.
 *
 *   response: 2xx JSON is the payload; non-2xx bodies map to the operation's
 *             typed error classes by status, then the shared HTTP-status
 *             classes, then {@link UnknownDaytonaError}.
 */
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientError from "effect/unstable/http/HttpClientError";
import type * as API from "@rikalabs/distilled-core/api";
import { makeRestProtocol } from "@rikalabs/distilled-core/protocol-rest";
import { getAnn } from "@rikalabs/distilled-core/protocol-http";
import { httpSymbol, type HttpTrait } from "@rikalabs/distilled-core/trait";
import type { API_ERRORS, ConfigError } from "@rikalabs/distilled-core/errors";
import { Credentials, type Config } from "./credentials.ts";
import { UnknownDaytonaError } from "./errors.ts";

/**
 * Error channel shared by every generated Daytona operation. Generated
 * service files annotate operations with `API.OperationMethod<I, O,
 * DaytonaOpError, DaytonaOpContext>` explicitly so the compiler never infers
 * these back out of the schema generics.
 */
export type DaytonaOpError =
  | InstanceType<(typeof API_ERRORS)[number]>
  | UnknownDaytonaError
  | ConfigError
  | HttpClientError.HttpClientError;

/** Context (requirements) shared by every generated Daytona operation. */
export type DaytonaOpContext = Credentials | HttpClient.HttpClient;

const toolboxUrls = new Map<string, string>();

/**
 * Record a sandbox's toolbox proxy base URL, as delivered by the control
 * plane (`toolboxProxyUrl` on Sandbox / SandboxListItem). The route hook and
 * `resolveToolboxUrl` consult this cache before falling back to a live
 * control-plane lookup.
 */
export const primeToolboxUrl = (sandboxId: string, url: string): void => {
  if (sandboxId && url) {
    toolboxUrls.set(sandboxId, url.replace(/\/+$/, ""));
  }
};

/** Drop a cached toolbox proxy URL (e.g. after the sandbox is deleted). */
export const evictToolboxUrl = (sandboxId: string): void => {
  toolboxUrls.delete(sandboxId);
};

/** Clear the whole toolbox proxy URL cache (e.g. when a client layer tears down). */
export const clearToolboxUrls = (): void => {
  toolboxUrls.clear();
};

/** Authorization headers shared by control-plane and toolbox requests. */
export const authHeaders = (creds: Config): Record<string, string> => ({
  Authorization: `Bearer ${Redacted.value(creds.apiKey)}`,
  ...(creds.organizationId !== undefined
    ? { "X-Daytona-Organization-ID": creds.organizationId }
    : {}),
});

/**
 * Resolve a sandbox's toolbox proxy base URL: cache first, then a live
 * `GET /sandbox/{id}/toolbox-proxy-url` against the control plane. Runs on
 * the calling fiber — `Credentials` and `HttpClient` must be in context.
 */
export const resolveToolboxUrl = (
  sandboxId: string,
): Effect.Effect<
  string,
  UnknownDaytonaError | HttpClientError.HttpClientError,
  Credentials | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const cached = toolboxUrls.get(sandboxId);
    if (cached !== undefined) return cached;
    const resolve = yield* Credentials;
    const creds = yield* resolve;
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.get(
        `${creds.apiBaseUrl}/sandbox/${sandboxId}/toolbox-proxy-url`,
      ).pipe(HttpClientRequest.setHeaders(authHeaders(creds))),
    );
    const text = yield* response.text;
    if (response.status >= 400) {
      return yield* Effect.fail(
        new UnknownDaytonaError({
          message: `toolbox-proxy-url lookup failed: HTTP ${response.status}`,
          body: text.slice(0, 512),
        }),
      );
    }
    let url: unknown;
    try {
      url = (JSON.parse(text) as { url?: unknown }).url;
    } catch {
      url = undefined;
    }
    if (typeof url !== "string" || !url) {
      return yield* Effect.fail(
        new UnknownDaytonaError({
          message: "toolbox-proxy-url lookup returned no url",
          body: text.slice(0, 512),
        }),
      );
    }
    const base = url.replace(/\/+$/, "");
    toolboxUrls.set(sandboxId, base);
    return base;
  });

export const DaytonaProtocol: Layer.Layer<API.Protocol> =
  makeRestProtocol<Config>({
    // The Credentials service holds an effect — resolving it here (per
    // request, on the calling fiber) picks up context-provided credentials.
    credentials: Effect.gen(function* () {
      const resolve = yield* Credentials;
      return yield* resolve;
    }),
    baseUrl: (creds) => creds.apiBaseUrl,
    headers: authHeaders,
    // Toolbox ops are generated with `/{sandboxId}/…` URI templates; route
    // them to the sandbox's own toolbox proxy base (see module comment).
    route: ({ input, inputAst }) =>
      Effect.gen(function* () {
        const http = getAnn(inputAst, httpSymbol) as HttpTrait | undefined;
        if (
          http === undefined ||
          typeof http.uri !== "string" ||
          !http.uri.startsWith("/{sandboxId}")
        ) {
          return undefined;
        }
        const sandboxId =
          typeof input === "object" && input !== null
            ? (input as Record<string, unknown>).sandboxId
            : undefined;
        if (typeof sandboxId !== "string" || !sandboxId) return undefined;
        const base = yield* resolveToolboxUrl(sandboxId);
        return { baseUrl: base };
      }),
    unknownError: ({ code, message, body }) =>
      new UnknownDaytonaError({
        code:
          typeof code === "string"
            ? code
            : code !== undefined
              ? String(code)
              : undefined,
        message,
        body,
      }),
  });
