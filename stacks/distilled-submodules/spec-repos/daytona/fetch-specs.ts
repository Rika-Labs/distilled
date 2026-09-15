#!/usr/bin/env bun
/**
 * Fetches the Daytona OpenAPI specs to ../specs/.
 *
 * Daytona publishes TWO documents on its docs site:
 *
 *   - openapi.json          — the control-plane API (OpenAPI 3.0). Sandboxes,
 *                             snapshots, organizations, toolbox proxy URLs.
 *   - toolbox-openapi.json  — the per-sandbox Toolbox API (Swagger 2.0). The
 *                             HTTP surface served by the daemon inside each
 *                             sandbox: filesystem, process execution, PTY.
 *
 * Neither has a git repo or a versioned URL, so the mirror snapshots both.
 *
 * Usage:
 *   bun run fetch-specs.ts
 *
 * The specs are saved to:
 *   ../specs/openapi.json
 *   ../specs/toolbox-openapi.json
 */

const SOURCES = [
  {
    url: "https://www.daytona.io/docs/openapi.json",
    output: "../specs/openapi.json",
    kind: "openapi" as const,
  },
  {
    url: "https://www.daytona.io/docs/toolbox-openapi.json",
    output: "../specs/toolbox-openapi.json",
    kind: "swagger" as const,
  },
];

import { existsSync, mkdirSync } from "fs";

const SPECS_DIR = "../specs";

if (!existsSync(SPECS_DIR)) {
  mkdirSync(SPECS_DIR, { recursive: true });
}

async function main() {
  for (const source of SOURCES) {
    console.log(`Fetching spec from ${source.url}...`);

    const response = await fetch(source.url, {
      headers: {
        accept: "application/json",
        "user-agent": "distilled.cloud-daytona-spec-mirror",
      },
    });

    if (!response.ok) {
      throw new Error(
        `Failed to fetch ${source.url}: ${response.status} ${response.statusText}`,
      );
    }

    const spec = (await response.json()) as Record<string, unknown>;

    // Fail here rather than three steps later in the generator: a login page
    // or a gutted response is still valid JSON, but it is not an API document.
    const version = spec[source.kind];
    if (typeof version !== "string" || spec.paths === undefined) {
      throw new Error(
        `${source.url} returned JSON without \`${source.kind}\`/\`paths\` — not an API document`,
      );
    }

    console.log(`Writing spec to ${source.output}...`);
    // 2-space indent + trailing newline, matching the other mirrors, so a
    // whitespace-only change upstream produces no diff.
    await Bun.write(source.output, JSON.stringify(spec, null, 2) + "\n");

    console.log(
      `Done! ${source.kind} ${version} — ${Object.keys(spec.paths as object).length} paths`,
    );
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
