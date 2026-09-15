#!/usr/bin/env bun
/**
 * sandbox-convert — turn the committed sandbox-bridge OpenAPI document into
 * a Smithy 2.0 JSON model.
 *
 * Input:  spec/sandbox-bridge.openapi.json — a verbatim extraction of the
 *         OpenAPI schema embedded in `@cloudflare/sandbox@0.12.9`
 *         (`dist/bridge/index.js`, `OPENAPI_SCHEMA`; re-derive with
 *         `bun scripts/sandbox-extract-spec.ts <path-to-dist-bundle>`).
 *         The bridge API is served by the SDK's `bridge()` worker wrapper
 *         (`@cloudflare/sandbox/bridge`) — it is a deployment-local HTTP
 *         API, not the Cloudflare platform REST API this package's other
 *         services cover.
 *         patches-sandbox/*.patch.json  (RFC-6902 ops applied to the
 *         document — currently drops the paths whose media types the
 *         pipeline cannot express: SSE exec, octet-stream file I/O, the
 *         websocket pty, and the octet-stream persist/hydrate pair. exec +
 *         file operations are hand-implemented in `src/sandbox/exec.ts` /
 *         `src/sandbox/files.ts` instead.)
 * Output: .generated-specs-sandbox/sandbox_bridge.json
 *
 * The model directory is deliberately separate from `.generated-specs`
 * (the platform API's 121 models) — each pipeline's directory scan must not
 * see the other's models.
 */
import * as path from "node:path";
import { runOpenApiConvert } from "@rikalabs/distilled-core/codegen/openapi-cli";

await runOpenApiConvert({
  root: path.resolve(import.meta.dir, ".."),
  specs: [
    {
      name: "sandbox_bridge",
      specPath: "spec/sandbox-bridge.openapi.json",
    },
  ],
  patchesDir: "patches-sandbox",
  outDir: ".generated-specs-sandbox",
  options: {
    namespace: "com.rikalabs.cloudflare.sandbox",
    serviceName: "CloudflareSandbox",
    skipDeprecated: true,
  },
});
