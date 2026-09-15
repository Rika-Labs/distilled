#!/usr/bin/env bun
/**
 * generate — turn the Smithy JSON models in .generated-specs into the Daytona
 * Effect SDK.
 *
 * Input:  .generated-specs/api.json      (control plane, written by scripts/convert.ts)
 *         .generated-specs/toolbox.json  (per-sandbox Toolbox)
 * Output: src/services/api.ts
 *         src/services/toolbox.ts
 *         src/services/index.ts
 *
 * The smithy→SDK compiler and CLI pipeline live in
 * `@rikalabs/distilled-core/codegen`; this script is Daytona's provider spec.
 */
import type { SdkSpec } from "@rikalabs/distilled-core/codegen/generator";
import { runGeneratorCli } from "@rikalabs/distilled-core/codegen/cli";

const NULLABLE_TRAIT = "com.distilled.openapi#nullable";
const ERROR_MATCHERS_TRAIT = "com.distilled.openapi#errorMatchers";
const RAW_RESPONSE_TRAIT = "com.distilled.openapi#rawResponse";
const SENSITIVE_TRAIT = "smithy.api#sensitive";

/** Daytona's provider spec for the shared smithy→SDK compiler. */
const daytonaSpec: SdkSpec = {
  nullableTrait: NULLABLE_TRAIT,
  errorMatchersTrait: ERROR_MATCHERS_TRAIT,

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

  // Sensitive strings (API keys, tokens): the schema member carries
  // T.SensitiveValue; the REST protocol delivers Redacted values and accepts
  // string | Redacted on input.
  memberTraitPipes: {
    [SENSITIVE_TRAIT]: "T.SensitiveValue",
  },
  memberTsType: (m) =>
    SENSITIVE_TRAIT in m.traits
      ? `string | Redacted.Redacted<string>${m.nullable ? " | null" : ""}`
      : undefined,

  // Unions surface as TS type unions over an opaque schema — the REST
  // protocol passes union content through verbatim (wire names ARE the TS
  // names), so no runtime case discrimination is needed.
  union: ({ name, caseTargets, tsRef }) => [
    `export type ${name} = ${caseTargets.map(tsRef).join(" | ") || "unknown"};`,
    `export const ${name} = S.Unknown as any as S.Schema<${name}>;\n`,
  ],

  // Cursor pagination (listSandboxes and friends carry `nextCursor`).
  paginationProfiles: {
    cursor: {
      strategy: "paginateCursor",
      itemsFallback: "items",
    },
  },

  operationDecl: {
    contextType: "DaytonaOpContext",
    commonErrorType: "DaytonaOpError",
    commonErrorClasses: ["UnknownDaytonaError"],
    protocol: "DaytonaProtocol",
    retry: "Retry.Retry",
  },

  corePackage: "@rikalabs/distilled-core",

  sourceNote: ".generated-specs (specs/spec-mirror-daytona)",

  // Sensitive member types reference Redacted; pull the import in when used.
  postProcess: (code) =>
    code.includes("Redacted.Redacted<")
      ? code.replace(
          `import * as S from "@rikalabs/distilled-core/schema";\n`,
          `import * as S from "@rikalabs/distilled-core/schema";\nimport * as Redacted from "effect/Redacted";\n`,
        )
      : code,
};

runGeneratorCli({
  description: "Generate the Daytona Effect SDK from the Smithy models",
  root: `${import.meta.dir}/..`,
  // patches/ holds OpenAPI-document patches consumed by scripts/convert.ts;
  // there is no smithy-model patch chain.
  patchesDir: false,
  spec: () => daytonaSpec,
});
