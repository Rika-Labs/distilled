#!/usr/bin/env bun
/**
 * generate — turn the Smithy JSON models in .generated-specs into the E2B
 * Effect SDK.
 *
 * Input:  .generated-specs/<group>.json  (written by scripts/convert.ts —
 *         one model per OpenAPI tag plus `envd`, `process`, `filesystem`)
 * Output: src/services/<group>.ts  +  src/services/index.ts
 *
 * The smithy→SDK compiler and CLI pipeline live in
 * `@rikalabs/distilled-core/codegen`; this script is E2B's provider spec.
 *
 * Two protocol bindings, chosen per model by namespace:
 *
 *   - `com.e2b.<tag>`      → E2BProtocol — the control plane
 *     (api.e2b.<domain>, `X-API-Key`, JSON request/response, header-bound
 *     pagination outputs filled from X-Next-Token / X-Total-Running).
 *   - `com.e2b.envd[.<x>]` → E2BEnvdProtocol — per-sandbox envd: the REST
 *     file/env endpoints as JSON, the `process`/`filesystem` proto services
 *     as Connect-RPC (`application/proto` unary, `application/connect+proto`
 *     server-streaming), all routed through the `EnvdConnection` in context.
 *
 * Member names keep the wire spelling (E2B's camelCase `templateID` /
 * snake_case `error_code` mix is the spelling its own docs use).
 */
import type { SdkSpec } from "@rikalabs/distilled-core/codegen/generator";
import { runGeneratorCli } from "@rikalabs/distilled-core/codegen/cli";
import {
  ERROR_MATCHERS_TRAIT,
  NULLABLE_TRAIT,
  RAW_RESPONSE_TRAIT,
} from "@rikalabs/distilled-core/codegen/openapi";
import { FORM_DATA_FILE_TRAIT, QUERY_JOIN_TRAIT } from "./convert.ts";

const SENSITIVE_TRAIT = "smithy.api#sensitive";
const HTTP_PAYLOAD_TRAIT = "smithy.api#httpPayload";
const PROTO_FIELD_TRAIT = "com.distilled.proto#field";
const PROTO_STREAMING_TRAIT = "com.distilled.proto#streaming";

const camel = (slug: string): string =>
  slug
    .split("_")
    .filter(Boolean)
    .map((s, i) => (i === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1)))
    .join("");

const isEnvdModel = (model: any): boolean => {
  for (const [id, shape] of Object.entries<any>(model.shapes ?? {})) {
    if (shape?.type === "service") return id.startsWith("com.e2b.envd");
  }
  return false;
};

/**
 * Input shape ids whose RPC streams its RESPONSE — stamped `T.ConnectStream()`
 * so the envd protocol sends an enveloped `application/connect+proto` request
 * instead of a raw `application/proto` one. The request body is a single
 * frame in both cases; only the content type + framing differ.
 */
const streamingInputIds = (model: any): ReadonlySet<string> => {
  const ids = new Set<string>();
  for (const shape of Object.values<any>(model.shapes ?? {})) {
    if (shape?.type !== "operation") continue;
    const streaming = shape.traits?.[PROTO_STREAMING_TRAIT];
    if (streaming?.response === true && shape.input?.target !== undefined) {
      ids.add(shape.input.target);
    }
  }
  return ids;
};

const specFor = (model: any): SdkSpec => {
  const envd = isEnvdModel(model);
  const connectStreams = streamingInputIds(model);

  return {
    sourceNote: ".generated-specs (e2b openapi/envd/proto → smithy)",
    corePackage: "@rikalabs/distilled-core",

    // Wire names ARE the TS surface — no renaming.
    nullableTrait: NULLABLE_TRAIT,
    errorMatchersTrait: ERROR_MATCHERS_TRAIT,

    extraBindings: [
      {
        // Sole member of a synthesized wrapper for bare array/scalar
        // response bodies — as a response's sole member, the response IS
        // the payload.
        trait: RAW_RESPONSE_TRAIT,
        binding: "rawResponse",
        pipe: "T.RawResponse()",
        rootPipe: "T.RawResponseRoot()",
      },
      {
        // envd file upload: multipart `file` member → a FormData file part.
        trait: FORM_DATA_FILE_TRAIT,
        binding: "file",
        pipe: "T.FormDataFile()",
        tsType: "File | Blob",
      },
    ],

    memberTraitPipes: {
      [SENSITIVE_TRAIT]: "T.SensitiveValue",
      [PROTO_FIELD_TRAIT]: "T.ProtoField",
      // `explode: false` array query members (state=running,paused) — the
      // protocol joins on encode.
      [QUERY_JOIN_TRAIT]: "T.QueryJoin",
    },
    memberTsType: (m) =>
      SENSITIVE_TRAIT in m.traits
        ? `string | Redacted.Redacted<string>${m.nullable ? " | null" : ""}`
        : HTTP_PAYLOAD_TRAIT in m.traits
          ? // Raw bodies: octet-stream file download on the way out, binary
            // payloads on the way in — bytes, not strings.
            "Uint8Array"
          : undefined,

    union: ({ name, caseTargets, tsRef }) => [
      `export type ${name} = ${caseTargets.map(tsRef).join(" | ") || "unknown"};`,
      `export const ${name} = S.Unknown as any as S.Schema<${name}>;\n`,
    ],

    // Struct-level pipes: the op's Http trait rides the input schema (the
    // protocol reads method/uri off it); server-streaming Connect RPCs get
    // the envelope marker.
    structPipes: ({ httpTrait, id }) => [
      ...(httpTrait ? [`T.Http(${JSON.stringify(httpTrait)})`] : []),
      ...(connectStreams.has(id) ? ["T.ConnectStream()"] : []),
    ],

    paginationProfiles: {
      // E2B pages by response header — the protocol injects nextToken into
      // the output object, so core's token-mode paginator drives
      // `.pages()`/`.items()` unchanged.
      token: {
        itemsFallback: "",
      },
    },

    operationDecl: envd
      ? {
          contextType: "E2BEnvdOpContext",
          commonErrorType: "E2BEnvdOpError",
          commonErrorClasses: ["UnknownE2BError"],
          protocol: "E2BEnvdProtocol",
          retry: "Retry.Retry",
        }
      : {
          contextType: "E2BOpContext",
          commonErrorType: "E2BOpError",
          commonErrorClasses: ["UnknownE2BError"],
          protocol: "E2BProtocol",
          retry: "Retry.Retry",
        },

    postProcess: (code) =>
      code.includes("Redacted.Redacted<")
        ? code.replace(
            `import * as S from "@rikalabs/distilled-core/schema";\n`,
            `import * as S from "@rikalabs/distilled-core/schema";\nimport * as Redacted from "effect/Redacted";\n`,
          )
        : code,
  };
};

runGeneratorCli({
  description: "Generate the E2B Effect SDK from the Smithy models",
  root: `${import.meta.dir}/..`,
  patchesDir: false,
  barrelExportName: camel,
  spec: specFor,
});
