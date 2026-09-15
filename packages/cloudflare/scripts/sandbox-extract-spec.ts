#!/usr/bin/env bun
/**
 * sandbox-extract-spec — re-derive spec/sandbox-bridge.openapi.json from an
 * installed `@cloudflare/sandbox` dist bundle.
 *
 * The bridge API's only published description is the `OPENAPI_SCHEMA`
 * object literal embedded in the SDK's `dist/bridge/index.js` (served live
 * by `bridge()`-wrapped workers at `GET /v1/openapi.json`). The container
 * surface is NOT part of the Cloudflare platform REST API and has no spec
 * mirror — the committed JSON is a hand-maintained extraction pinned to
 * the SDK version the adapter was qualified against (0.12.9).
 *
 * Usage:
 *   bun scripts/sandbox-extract-spec.ts <path-to-dist/bridge/index.js> [out.json]
 */
import * as fs from "node:fs";
import * as path from "node:path";

const bundle = process.argv[2];
const out =
  process.argv[3] ??
  path.resolve(import.meta.dir, "../spec/sandbox-bridge.openapi.json");

if (bundle === undefined) {
  console.error(
    "usage: sandbox-extract-spec.ts <path-to-dist/bridge/index.js> [out.json]",
  );
  process.exit(1);
}

const src = await fs.promises.readFile(bundle, "utf8");
const start = src.indexOf("const OPENAPI_SCHEMA = ");

if (start === -1) {
  console.error("OPENAPI_SCHEMA literal not found in the bundle");
  process.exit(1);
}

const open = src.indexOf("{", start);
let depth = 0;
let end = -1;

for (let i = open; i < src.length; i++) {
  const ch = src[i];

  if (ch === "{") depth++;
  else if (ch === "}") {
    depth--;

    if (depth === 0) {
      end = i;
      break;
    }
  }
}

if (end === -1) {
  console.error("OPENAPI_SCHEMA literal is unbalanced");
  process.exit(1);
}

const schema = new Function(`return (${src.slice(open, end + 1)})`)() as {
  openapi?: string;
  paths?: Record<string, unknown>;
};

if (typeof schema.openapi !== "string" || schema.paths === undefined) {
  console.error("extracted value is not an OpenAPI document");
  process.exit(1);
}

await fs.promises.writeFile(out, JSON.stringify(schema, null, 2) + "\n");
console.log(`wrote ${out} (${Object.keys(schema.paths).length} paths)`);
