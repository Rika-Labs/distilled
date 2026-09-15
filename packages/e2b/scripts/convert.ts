#!/usr/bin/env bun
/**
 * convert — turn E2B's API descriptions into Smithy 2.0 JSON models.
 *
 * Inputs (mirrored under specs/spec-mirror-e2b by the spec pipeline, or
 * fetched into specs/.local via `pnpm specs:local e2b`):
 *
 *   openapi.yml        e2b-dev/infra spec/openapi.yml — the control plane:
 *                      sandbox lifecycle, templates, snapshots, volumes,
 *                      secrets, events, API keys, admin/cluster reads.
 *   envd.yaml          packages/envd/spec/envd.yaml — the per-sandbox envd
 *                      REST surface (/health, /envs, /files, /files/compose,
 *                      /metrics). Internal lifecycle endpoints carry
 *                      `x-internal: true` and are dropped here.
 *   process.proto      packages/envd/spec/process/process.proto — envd's
 *                      process RPCs (start/connect/list/input/signal).
 *   filesystem.proto   packages/envd/spec/filesystem/filesystem.proto —
 *                      envd's filesystem RPCs (stat/mkdir/move/list/remove/
 *                      watch). File CONTENT moves over the REST /files
 *                      endpoints; the RPC surface is metadata + watchers.
 *
 * Output: .generated-specs/<group>.json — one Smithy model per OpenAPI tag
 * (`sandboxes`, `templates`, …), plus `envd.json` for the envd REST surface
 * and `process.json`/`filesystem.json` for the Connect-RPC services.
 *
 * The OpenAPI→Smithy converter lives in `@rikalabs/distilled-core/codegen/openapi`;
 * the proto→Smithy converter in `codegen/proto`. Post-conversion surgery
 * happens HERE (not via generated-code edits):
 *
 *   - X-Next-Token pagination: E2B's list endpoints page by a RESPONSE
 *     HEADER (`X-Next-Token`, plus `X-Total-Running` on /v2/sandboxes) rather
 *     than a body member. The converter emits the bare-array body as a
 *     sole-member `body` wrapper; this script restructures the output into
 *     `{ <items>, nextToken?, totalRunning? }` — header-bound members the
 *     protocol fills from response headers — and stamps
 *     `smithy.api#paginated` (token mode) so `.pages()`/`.items()` work.
 *
 *   - `explode: false` array query params (`/v2/sandboxes` `state`): E2B
 *     wants comma-joined values (`state=running,paused`), not repeated
 *     pairs. The member keeps its array type and gains the
 *     `com.e2b.api#queryJoin` trait; the protocol joins on encode.
 *
 *   - `GET /files` (envd download): the spec declares an octet-stream body
 *     the OpenAPI converter has no output modeling for, so the op's output
 *     is repointed at a synthesized `{ body: Blob httpPayload }` structure —
 *     the protocol hands back the raw bytes.
 *
 *   - `POST /files` (envd upload): the multipart `file` member gains the
 *     `com.e2b.envd#formDataFile` trait so generation binds it to
 *     `T.FormDataFile()` (`File | Blob`).
 *
 * `scripts/generate.ts` (runGeneratorCli, patchesDir: false) then compiles
 * the models; the patch chain under `patches/` applies HERE.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  applyOperation,
  isStaleTargetError,
  type PatchFile,
} from "@rikalabs/distilled-core/json-patch";
import { convertOpenApiToSmithy } from "@rikalabs/distilled-core/codegen/openapi";
import {
  convertProtoToSmithy,
  parseProto,
} from "@rikalabs/distilled-core/codegen/proto";
import { finalizeConvert } from "@rikalabs/distilled-core/codegen/patches";
import { resolveSpecPath } from "@rikalabs/distilled-core/codegen/spec-path";

const rootDir = path.resolve(import.meta.dir, "..");
const specDir = (name: string) =>
  resolveSpecPath(rootDir, `specs/spec-mirror-e2b/specs/${name}`);
const patchDir = path.join(rootDir, "patches");
const outDir = path.join(rootDir, ".generated-specs");

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

const HTTP_HEADER_TRAIT = "smithy.api#httpHeader";
const HTTP_PAYLOAD_TRAIT = "smithy.api#httpPayload";
const REQUIRED_TRAIT = "smithy.api#required";
const PAGINATED_TRAIT = "smithy.api#paginated";
const PAGINATED_OUTPUT_TRAIT = "smithy.api#output";
/** Custom member trait: join an array query member into one `k=a,b,c` pair. */
export const QUERY_JOIN_TRAIT = "com.e2b.api#queryJoin";
/** Custom member trait: multipart `file` member → `T.FormDataFile()`. */
export const FORM_DATA_FILE_TRAIT = "com.e2b.envd#formDataFile";

const toSlug = (tag: string): string =>
  tag
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();

const toPascal = (slug: string): string =>
  slug
    .split("_")
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");

const readYaml = (file: string, hint: string): any => {
  if (!fs.existsSync(file)) {
    throw new Error(
      `${file} not found — run \`pnpm specs:local e2b\` (or \`bun run specs:fetch\` once the mirror exists) to fetch ${hint}`,
    );
  }
  return Bun.YAML.parse(fs.readFileSync(file, "utf-8"));
};

// =============================================================================
// Patch chain — patches/<tag>/*.patch.json on the control-plane document
// =============================================================================
const SKIP_PATCH_NAMES = new Set(["_metadata.json"]);
const isSmithyPatchPath = (patchPath: unknown): boolean =>
  typeof patchPath === "string" && patchPath.startsWith("/shapes/");

const listPatchFiles = (root: string): string[] => {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  for (const ent of fs
    .readdirSync(root, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    if (ent.isFile()) {
      console.warn(
        `   ⚠️  patches/${ent.name} is not patches/<service>/<op>.json — ignored`,
      );
      continue;
    }
    if (!ent.isDirectory()) continue;
    const files = fs
      .readdirSync(path.join(root, ent.name))
      .filter((f) => f.endsWith(".json") && !SKIP_PATCH_NAMES.has(f))
      .sort(
        (a, b) =>
          Number(a.endsWith(".manual.json")) -
            Number(b.endsWith(".manual.json")) || a.localeCompare(b),
      );
    for (const file of files) out.push(path.join(ent.name, file));
  }
  return out;
};

// =============================================================================
// 1. Control plane — openapi.yml → one model per tag
// =============================================================================
const fullSpec = readYaml(
  specDir("openapi.yml"),
  "the control-plane OpenAPI document",
);

let patchFiles = 0;
let staleOps = 0;
const badPatches: string[] = [];
for (const rel of listPatchFiles(patchDir)) {
  const parsed = JSON.parse(
    fs.readFileSync(path.join(patchDir, rel), "utf-8"),
  ) as PatchFile;
  for (const patchOp of parsed.patches ?? []) {
    if (isSmithyPatchPath(patchOp.path)) continue;
    try {
      applyOperation(fullSpec, patchOp);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isStaleTargetError(msg)) {
        staleOps++;
        console.warn(`   ⚠️  stale: ${rel} [${patchOp.op} ${patchOp.path}]`);
      } else {
        badPatches.push(`${rel} [${patchOp.op} ${patchOp.path}]: ${msg}`);
      }
    }
  }
  patchFiles++;
}
if (badPatches.length) {
  for (const b of badPatches) console.error(`❌ bad patch: ${b}`);
  throw new Error(
    `${badPatches.length} malformed patch operation(s) — fix or remove them`,
  );
}
if (patchFiles) {
  console.log(
    `🩹 ${patchFiles} patch files applied` +
      (staleOps ? ` (${staleOps} stale op(s) skipped)` : ""),
  );
}

// ---- Bucket paths by primary tag -------------------------------------------
const tagBuckets = new Map<string, Record<string, Record<string, unknown>>>();
const unrouted: string[] = [];
const deprecated: string[] = [];
for (const [pathTemplate, pathItem] of Object.entries<Record<string, unknown>>(
  fullSpec.paths,
)) {
  for (const method of HTTP_METHODS) {
    const op = (pathItem as Record<string, any>)[method];
    if (!op) continue;
    if (op.deprecated === true) {
      deprecated.push(`${method.toUpperCase()} ${pathTemplate}`);
    }
    const rawTag: string | undefined =
      Array.isArray(op.tags) && op.tags.length > 0 ? op.tags[0] : undefined;
    if (rawTag === undefined) {
      unrouted.push(`${method.toUpperCase()} ${pathTemplate}`);
    }
    const slug = toSlug(rawTag ?? "misc") || "misc";
    if (!tagBuckets.has(slug)) tagBuckets.set(slug, {});
    const bucketPaths = tagBuckets.get(slug)!;
    if (!bucketPaths[pathTemplate]) {
      const pathParams = (pathItem as Record<string, any>).parameters;
      bucketPaths[pathTemplate] = pathParams ? { parameters: pathParams } : {};
    }
    (bucketPaths[pathTemplate] as Record<string, unknown>)[method] = op;
  }
}
if (unrouted.length) {
  console.warn(
    `   ⚠️  ${unrouted.length} untagged operation(s) fell into \`misc\`:\n      ` +
      unrouted.join("\n      "),
  );
}

// =============================================================================
// Header-pagination + explode:false detection (read off the OpenAPI ops, so an
// upstream change to the wire shape stops stamping here)
// =============================================================================

/**
 * Route → the response member that carries the bare-array items. E2B's
 * paginated list endpoints are: /v2/sandboxes (+ X-Total-Running),
 * /v2/templates, /snapshots, /secrets. Any other route that grows an
 * X-Next-Token header with a bare-array body falls back to `items` and is
 * reported so the naming choice stays visible.
 */
const ITEMS_MEMBER: Readonly<Record<string, string>> = {
  "/v2/sandboxes": "sandboxes",
  "/v2/templates": "templates",
  "/snapshots": "snapshots",
  "/secrets": "secrets",
};

interface HeaderPagination {
  readonly itemsMember: string;
  readonly hasTotalRunning: boolean;
}

/**
 * The op pages via the `X-Next-Token` response header when: the 200 response
 * declares that header, the request carries the `nextToken` query param, and
 * the body is a bare array (non-array bodies — e.g. /templates/{templateID}'s
 * TemplateWithBuilds — keep their header unpaginated; there is no items
 * member to hang a `.items()` stream on).
 */
const headerPaginationFor = (
  op: any,
  pathTemplate: string,
): HeaderPagination | undefined => {
  const headers = op.responses?.["200"]?.headers;
  if (headers === undefined || typeof headers !== "object") return undefined;
  const headerKeys = Object.keys(headers).map((k) => k.toLowerCase());
  if (!headerKeys.includes("x-next-token")) return undefined;

  const params = (op.parameters ?? []) as Array<any>;
  const hasNextToken = params.some(
    (p) =>
      (p?.in === "query" && p?.name === "nextToken") ||
      p?.$ref === "#/components/parameters/paginationNextToken",
  );
  if (!hasNextToken) return undefined;

  const schema = op.responses?.["200"]?.content?.["application/json"]?.schema;
  if (schema?.type !== "array") return undefined;

  return {
    itemsMember: ITEMS_MEMBER[pathTemplate] ?? "items",
    hasTotalRunning: headerKeys.includes("x-total-running"),
  };
};

/** Query params with `explode: false` + array schema → `k=a,b,c` on the wire. */
const explodeFalseArrays = (op: any): ReadonlyArray<string> =>
  ((op.parameters ?? []) as Array<any>)
    .filter(
      (p) =>
        p?.in === "query" &&
        p?.explode === false &&
        p?.schema?.type === "array",
    )
    .map((p) => String(p.name));

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

let written = 0;
let totalOps = 0;
let totalPaginated = 0;
const emptyBuckets: string[] = [];

/**
 * Restructure a converter-emitted sole-member `body` response wrapper into
 * `{ <itemsMember>: <array>, nextToken?: string, totalRunning?: number }`
 * and return the paginated trait to stamp on the operation.
 */
const restructureHeaderPaginatedOutput = (
  model: any,
  outputId: string,
  pag: HeaderPagination,
): Record<string, unknown> => {
  const out = model.shapes[outputId];
  const body = out?.members?.body;
  if (out?.type !== "structure" || body === undefined) {
    throw new Error(
      `expected a sole-member body wrapper at ${outputId} — the converter's ` +
        `bare-array response shape changed; update scripts/convert.ts`,
    );
  }
  const members: Record<string, unknown> = {
    [pag.itemsMember]: body,
    nextToken: {
      target: "smithy.api#String",
      traits: { [HTTP_HEADER_TRAIT]: "X-Next-Token" },
    },
  };
  if (pag.hasTotalRunning) {
    members.totalRunning = {
      target: "smithy.api#Integer",
      traits: { [HTTP_HEADER_TRAIT]: "X-Total-Running" },
    };
  }
  out.members = members;
  return {
    mode: "token",
    inputToken: "nextToken",
    outputToken: "nextToken",
    items: pag.itemsMember,
  };
};

for (const slug of [...tagBuckets.keys()].sort()) {
  const paths = tagBuckets.get(slug)!;
  const subSpec = { ...fullSpec, paths };
  const model = convertOpenApiToSmithy(subSpec, {
    namespace: `com.e2b.${slug.replace(/_/g, ".")}`,
    serviceName: toPascal(slug),
    // E2B's error model is one shared envelope ({code, error_code?, message})
    // on every operation — nothing per-status to type, so failures dispatch
    // at runtime from the status + envelope (see src/protocol.ts), mirroring
    // the official SDK's status-driven error classes.
    statusToErrorClass: {},
  });

  const operations = Object.entries<any>(model.shapes).filter(
    ([, s]) => s.type === "operation",
  );
  if (operations.length === 0) {
    emptyBuckets.push(slug);
    continue;
  }

  // ---- Surgery: header pagination + explode:false query joins --------------
  const paginationByRoute = new Map<string, HeaderPagination>();
  const joinsByRoute = new Map<string, ReadonlyArray<string>>();
  for (const [pathTemplate, pathItem] of Object.entries<any>(paths)) {
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op) continue;
      const pag = headerPaginationFor(op, pathTemplate);
      if (pag)
        paginationByRoute.set(`${method.toUpperCase()} ${pathTemplate}`, pag);
      const joins = explodeFalseArrays(op);
      if (joins.length)
        joinsByRoute.set(`${method.toUpperCase()} ${pathTemplate}`, joins);
    }
  }
  let paginated = 0;
  for (const [, shape] of operations) {
    const http = shape.traits?.["smithy.api#http"];
    if (!http) continue;
    const route = `${http.method} ${http.uri}`;
    const pag = paginationByRoute.get(route);
    if (pag) {
      shape.traits[PAGINATED_TRAIT] = restructureHeaderPaginatedOutput(
        model,
        shape.output.target,
        pag,
      );
      paginated++;
    }
    const joins = joinsByRoute.get(route);
    if (joins !== undefined) {
      const input = model.shapes[shape.input.target];
      for (const name of joins) {
        const member = input?.members?.[name];
        if (member !== undefined) {
          member.traits = { ...member.traits, [QUERY_JOIN_TRAIT]: "," };
        }
      }
    }
  }
  if (paginated !== paginationByRoute.size) {
    throw new Error(
      `${slug}: ${paginationByRoute.size} header-paginated route(s) detected but ` +
        `${paginated} stamped — an operation's http uri no longer matches its OpenAPI path`,
    );
  }

  fs.writeFileSync(
    path.join(outDir, `${slug}.json`),
    JSON.stringify(model, null, 2) + "\n",
  );
  written++;
  totalOps += operations.length;
  totalPaginated += paginated;
}

// =============================================================================
// 2. envd REST — envd.yaml → envd.json (x-internal endpoints dropped)
// =============================================================================
const envdSpec = readYaml(specDir("envd.yaml"), "the envd OpenAPI document");
const droppedInternal: string[] = [];
const envdPaths: Record<string, Record<string, unknown>> = {};
for (const [pathTemplate, pathItem] of Object.entries<Record<string, any>>(
  envdSpec.paths ?? {},
)) {
  const kept: Record<string, unknown> = {};
  if (pathItem.parameters !== undefined) kept.parameters = pathItem.parameters;
  for (const method of HTTP_METHODS) {
    const op = pathItem[method];
    if (!op) continue;
    if (op["x-internal"] === true) {
      droppedInternal.push(`${method.toUpperCase()} ${pathTemplate}`);
      continue;
    }
    kept[method] = op;
  }
  if (Object.keys(kept).some((k) => k !== "parameters")) {
    envdPaths[pathTemplate] = kept;
  }
}

const envdModel = convertOpenApiToSmithy(
  { ...envdSpec, paths: envdPaths },
  {
    namespace: "com.e2b.envd",
    serviceName: "Envd",
    statusToErrorClass: {},
  },
);

{
  const ops = Object.entries<any>(envdModel.shapes).filter(
    ([, s]) => s.type === "operation",
  );

  // `GET /files` — octet-stream download: repoint the op's output at a
  // synthesized `{ body: Blob httpPayload }` so the protocol returns raw
  // bytes (Uint8Array on the TS surface via memberTsType in generate.ts).
  const download = ops.find(
    ([, s]) =>
      s.traits?.["smithy.api#http"]?.method === "GET" &&
      s.traits?.["smithy.api#http"]?.uri === "/files",
  );
  if (download === undefined) {
    throw new Error("envd: GET /files not found in the converted model");
  }
  // `smithy.api#Blob` resolves to `S.String`/`string` through the generator's
  // prelude — inert here because the envd protocol returns the member's
  // value straight from `response.arrayBuffer` (memberTsType keeps the TS
  // surface honest as `Uint8Array`).
  const downloadOutId = "com.e2b.envd#DownloadFileResponse";
  envdModel.shapes[downloadOutId] = {
    type: "structure",
    members: {
      body: {
        target: "smithy.api#Blob",
        traits: { [HTTP_PAYLOAD_TRAIT]: {}, [REQUIRED_TRAIT]: {} },
      },
    },
    traits: { [PAGINATED_OUTPUT_TRAIT]: {} },
  };
  download[1].output = { target: downloadOutId };

  // `POST /files` — multipart upload: mark the `file` member for the
  // FormDataFile binding (File | Blob on the TS surface, appended as a file
  // part on the wire).
  const upload = ops.find(
    ([, s]) =>
      s.traits?.["smithy.api#http"]?.method === "POST" &&
      s.traits?.["smithy.api#http"]?.uri === "/files",
  );
  if (upload === undefined) {
    throw new Error("envd: POST /files not found in the converted model");
  }
  const uploadInput = envdModel.shapes[upload[1].input.target];
  const fileMember = uploadInput?.members?.file;
  if (fileMember === undefined) {
    throw new Error(
      "envd: POST /files lost its `file` multipart member — check the File requestBody conversion",
    );
  }
  fileMember.traits = {
    ...fileMember.traits,
    [FORM_DATA_FILE_TRAIT]: {},
  };

  fs.writeFileSync(
    path.join(outDir, "envd.json"),
    JSON.stringify(envdModel, null, 2) + "\n",
  );
  written++;
  totalOps += ops.length;
  if (droppedInternal.length) {
    console.log(
      `🗑️  ${droppedInternal.length} x-internal envd endpoint(s) skipped:\n      ` +
        droppedInternal.join("\n      "),
    );
  }
}

// =============================================================================
// 3. envd Connect RPCs — process.proto + filesystem.proto
// =============================================================================
const PROTO_FILES: ReadonlyArray<{
  readonly file: string;
  readonly slug: string;
  readonly service: string;
  readonly title: string;
}> = [
  {
    file: "process.proto",
    slug: "process",
    service: "process.Process",
    title: "E2B envd Process",
  },
  {
    file: "filesystem.proto",
    slug: "filesystem",
    service: "filesystem.Filesystem",
    title: "E2B envd Filesystem",
  },
];

for (const proto of PROTO_FILES) {
  const file = specDir(proto.file);
  if (!fs.existsSync(file)) {
    throw new Error(
      `${file} not found — run \`pnpm specs:local e2b\` to fetch ${proto.file}`,
    );
  }
  const parsed = parseProto(fs.readFileSync(file, "utf-8"), proto.file);
  // Client-streaming RPCs (`StreamInput`) have no `API.make*` shape — the
  // generator only understands unary and server-streaming. Drop them at the
  // source: stdin streaming is covered by the unary `SendInput`, the same
  // RPC the official SDK's `commands.sendInput` uses.
  const service = parsed.services.find((s) => s.fullName === proto.service);
  if (service === undefined) {
    throw new Error(
      `proto service ${proto.service} not found in ${proto.file}`,
    );
  }
  const clientStreaming = service.rpcs
    .filter((r) => r.requestStream)
    .map((r) => r.name);
  const rpcNames = new Set(
    service.rpcs.filter((r) => !r.requestStream).map((r) => r.name),
  );
  const result = convertProtoToSmithy({
    files: [parsed],
    namespace: `com.e2b.envd.${proto.slug}`,
    serviceName: toPascal(proto.slug),
    serviceTitle: proto.title,
    serviceDocumentation:
      `${proto.service} — Connect-RPC service served by envd inside each ` +
      `sandbox. Unary calls are POSTs with an application/proto body; ` +
      `server-streaming calls are application/connect+proto envelopes. ` +
      `Requests route to the sandbox's envd URL with X-Access-Token auth.`,
    protoService: proto.service,
    rpcNames,
    // Keep server-streaming RPCs (Start/Connect/WatchDir → API.makeStream);
    // client-streaming ones (StreamInput) were filtered out above.
    skipStreaming: false,
    skipDeprecated: true,
  });
  if (clientStreaming.length) {
    console.log(
      `   ${proto.slug}: client-streaming RPC(s) skipped (SendInput covers stdin): ${clientStreaming.join(", ")}`,
    );
  }
  fs.writeFileSync(
    path.join(outDir, `${proto.slug}.json`),
    JSON.stringify(result.model, null, 2) + "\n",
  );
  written++;
  totalOps += result.converted;
  console.log(
    `   ${proto.slug}: ${result.converted} ops, ${result.skippedStreaming} streaming skipped, ${result.shapeCount} shapes`,
  );
}

if (deprecated.length) {
  console.log(
    `🗑️  ${deprecated.length} deprecated operation(s) present (generated anyway):\n      ` +
      deprecated.join("\n      "),
  );
}
if (emptyBuckets.length) {
  console.log(
    `   (${emptyBuckets.length} tag(s) dropped — no operations: ${emptyBuckets.join(", ")})`,
  );
}
console.log(
  `✅ ${written} Smithy models (${totalOps} operations, ${totalPaginated} header-paginated) → ${outDir}`,
);

await finalizeConvert({ root: rootDir });
