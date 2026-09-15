#!/usr/bin/env bun
/**
 * sandbox-generate — turn the sandbox-bridge Smithy model into the bridge
 * Effect SDK.
 *
 * Input:  .generated-specs-sandbox/sandbox_bridge.json  (written by
 *         scripts/sandbox-convert.ts)
 * Output: src/sandbox/services/sandbox_bridge.ts  +  services/index.ts
 *
 * Separate smithyDir/outDir from the platform pipeline so neither scans the
 * other's models. Wire member names keep the spec's snake_case
 * (`timeout_ms`, `exit_code`) — the REST protocol maps TS names through
 * each member's `T.Body` annotation, so the TS surface gets camelCase
 * while the wire spelling is preserved.
 */
import type { SdkSpec } from "@rikalabs/distilled-core/codegen/generator";
import { runGeneratorCli } from "@rikalabs/distilled-core/codegen/cli";

const NULLABLE_TRAIT = "com.distilled.openapi#nullable";
const ERROR_MATCHERS_TRAIT = "com.distilled.openapi#errorMatchers";
const RAW_RESPONSE_TRAIT = "com.distilled.openapi#rawResponse";

const spec: SdkSpec = {
  nullableTrait: NULLABLE_TRAIT,
  errorMatchersTrait: ERROR_MATCHERS_TRAIT,
  corePackage: "@rikalabs/distilled-core",

  extraBindings: [
    {
      // Sole member of a synthesized wrapper for bare array/scalar response
      // bodies; as the response's only member, the response IS the payload.
      trait: RAW_RESPONSE_TRAIT,
      binding: "rawResponse",
      pipe: "T.RawResponse()",
      rootPipe: "T.RawResponseRoot()",
    },
  ],

  // Unions surface as TS type unions over an opaque schema — the bridge
  // surface has no discriminated unions the REST protocol needs to
  // discriminate (mount options validate server-side).
  union: ({ name, caseTargets, tsRef }) => [
    `export type ${name} = ${caseTargets.map(tsRef).join(" | ") || "unknown"};`,
    `export const ${name} = S.Unknown as any as S.Schema<${name}>;\n`,
  ],

  operationDecl: {
    contextType: "SandboxBridgeOpContext",
    commonErrorType: "SandboxBridgeOpError",
    commonErrorClasses: ["UnknownCloudflareSandboxError"],
    protocol: "SandboxBridgeProtocol",
    retry: "Retry.Retry",
  },

  sourceNote: ".generated-specs-sandbox (spec/sandbox-bridge.openapi.json)",
};

runGeneratorCli({
  description: "Generate the Cloudflare Sandbox bridge Effect SDK",
  root: `${import.meta.dir}/..`,
  // The bridge model lives in its own directory — never the platform's
  // .generated-specs (121 models) — and emits into the sandbox subtree.
  smithyDir: ".generated-specs-sandbox",
  outDir: "src/sandbox/services",
  // patches-sandbox/ holds OpenAPI-document patches consumed by
  // scripts/sandbox-convert.ts; there is no smithy-model patch chain.
  patchesDir: false,
  spec: () => spec,
});
