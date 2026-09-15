/**
 * HTTP transport for E2B.
 *
 * Both planes ride the ambient `fetch` client: the control plane is plain
 * REST JSON, and envd's Connect-RPC endpoints accept `application/proto` /
 * `application/connect+proto` over HTTP/1.1 with a chunked (streaming)
 * response body — the same transport the official SDK's connect-web
 * transport uses. No HTTP/2 requirement: Connect's envelope framing is in
 * the body, not in trailers, so nothing is lost to fetch's trailer
 * blindness.
 *
 * Exported as a layer so callers can pin the package to a custom
 * `HttpClient` (proxy, instrumentation) under `E2BHttpClient`.
 */
import * as Layer from "effect/Layer";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

/** `HttpClient` layer for E2B — the ambient `fetch` client. */
export const E2BHttpClient: Layer.Layer<HttpClient.HttpClient> =
  FetchHttpClient.layer;
