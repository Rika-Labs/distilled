#!/usr/bin/env bun
/**
 * Mirrors E2B's API descriptions into ../specs/.
 *
 * E2B publishes two wire surfaces from one repository (e2b-dev/infra):
 *
 *   - `spec/openapi.yml` — the control plane OpenAPI 3.0 document
 *     (sandbox lifecycle, templates, api-keys, volumes, secrets, events…)
 *   - `packages/envd/spec/envd.yaml` — the per-sandbox envd REST API
 *     (file upload/download, env vars, health, metrics)
 *   - `packages/envd/spec/{process,filesystem}/*.proto` — the envd
 *     connect-RPC services (process exec/streaming, filesystem metadata)
 *
 * Only those four files are downloaded, straight from
 * raw.githubusercontent.com — the upstream repository is never cloned.
 *
 * Usage:
 *   bun run fetch-specs.ts
 *
 * Specs are saved to:
 *   ../specs/openapi.yml
 *   ../specs/envd.yaml
 *   ../specs/process.proto
 *   ../specs/filesystem.proto
 */

import { mkdirSync } from "fs";

/** Upstream repository, as `<owner>/<repo>`. */
const REPO = "e2b-dev/infra";
/** Branch (or tag/commit) to mirror. */
const REF = "main";

interface SpecFile {
  /** Path within {@link REPO}. */
  path: string;
  /** Path within ../specs/ to write it to. */
  output: string;
  /** Sanity check applied to the fetched body before writing it. */
  kind: "openapi" | "proto3";
}

const FILES: SpecFile[] = [
  { path: "spec/openapi.yml", output: "openapi.yml", kind: "openapi" },
  {
    path: "packages/envd/spec/envd.yaml",
    output: "envd.yaml",
    kind: "openapi",
  },
  {
    path: "packages/envd/spec/process/process.proto",
    output: "process.proto",
    kind: "proto3",
  },
  {
    path: "packages/envd/spec/filesystem/filesystem.proto",
    output: "filesystem.proto",
    kind: "proto3",
  },
];

const SPECS_DIR = "../specs";

mkdirSync(SPECS_DIR, { recursive: true });

/**
 * The raw URL for a path in {@link REPO}. Each segment is encoded
 * individually so paths containing characters like `(` survive the round
 * trip while the separators do not.
 */
const rawUrl = (path: string) =>
  `https://raw.githubusercontent.com/${REPO}/${REF}/${path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;

const isOpenApi = (text: string): boolean =>
  /^openapi:\s*["']?3\./m.test(text) && /^paths:/m.test(text);

const isProto3 = (text: string): boolean =>
  /syntax\s*=\s*"proto3"\s*;/.test(text) && /\bservice\s+\w+/.test(text);

async function main() {
  for (const file of FILES) {
    const url = rawUrl(file.path);
    console.log(`Fetching ${url}...`);

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch ${url}: ${response.status} ${response.statusText}`,
      );
    }

    const text = await response.text();
    const valid = file.kind === "openapi" ? isOpenApi(text) : isProto3(text);
    if (!valid) {
      throw new Error(
        `${url} is not a ${file.kind} description ` +
          `(missing the expected header markers) — ` +
          `refusing to write a gutted/non-spec body`,
      );
    }

    const outputPath = `${SPECS_DIR}/${file.output}`;
    console.log(`Writing ${outputPath}...`);
    const body = text.endsWith("\n") ? text : `${text}\n`;
    await Bun.write(outputPath, body);
  }

  console.log("Done!");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
