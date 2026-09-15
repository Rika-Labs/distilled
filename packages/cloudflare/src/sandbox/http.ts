/**
 * Sandbox-bridge HTTP client layer — hand-written.
 *
 * Unlike Modal (which needs a bespoke gRPC transport), the bridge is plain
 * fetch-compatible HTTP/1.1 JSON + octet-stream + SSE, so the default
 * `FetchHttpClient` suffices. Exported as a named layer so consumers have a
 * stable seam if a custom transport (e.g. a service-binding client inside a
 * worker) is ever needed — provide it wherever `HttpClient.HttpClient` is
 * required instead.
 */
import * as Layer from "effect/Layer";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

export const SandboxBridgeHttpClient: Layer.Layer<HttpClient.HttpClient> =
  FetchHttpClient.layer;
