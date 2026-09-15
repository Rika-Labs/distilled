#!/usr/bin/env bun
/**
 * convert — turn Daytona's two published API documents into Smithy 2.0 JSON
 * models.
 *
 * Input:  specs/spec-mirror-daytona/specs/openapi.json          (control plane, OpenAPI 3.0)
 *         specs/spec-mirror-daytona/specs/toolbox-openapi.json  (per-sandbox Toolbox, Swagger 2.0)
 *         patches/*.patch.json  (RFC-6902 patches to the OpenAPI documents)
 * Output: .generated-specs/api.json
 *         .generated-specs/toolbox.json
 *
 * The Toolbox document describes the daemon INSIDE each sandbox; its URLs are
 * relative to a per-sandbox origin (`<toolboxProxyUrl>/<sandboxId>`). The
 * preprocess below rewrites every toolbox path to `/{sandboxId}<path>` so
 * each generated operation carries a real `sandboxId` path member — which is
 * what the REST protocol's `route` hook uses to send the request to the
 * sandbox's own proxy URL instead of the control plane.
 */
import * as path from "node:path";
import { runOpenApiConvert } from "@rikalabs/distilled-core/codegen/openapi-cli";

await runOpenApiConvert({
  root: path.resolve(import.meta.dir, ".."),
  specs: [
    {
      name: "api",
      specPath: "specs/spec-mirror-daytona/specs/openapi.json",
    },
    {
      name: "toolbox",
      specPath: "specs/spec-mirror-daytona/specs/toolbox-openapi.json",
      preprocess: (spec: any) => {
        const sandboxIdParam = {
          name: "sandboxId",
          in: "path",
          required: true,
          type: "string",
          description: "Sandbox ID the toolbox request targets",
        };
        const paths: Record<string, unknown> = {};
        for (const [p, item] of Object.entries<any>(spec.paths ?? {})) {
          const key = `/{sandboxId}${p}`;
          if (typeof item !== "object" || item === null) {
            paths[key] = item;
            continue;
          }
          // Path-item level: every operation under this path inherits the
          // label member (converter merges path-item + operation params).
          paths[key] = {
            ...item,
            parameters: [sandboxIdParam, ...(item.parameters ?? [])],
          };
        }
        spec.paths = paths;
      },
      options: {
        namespace: "com.daytona.toolbox",
        serviceName: "Toolbox",
      },
    },
  ],
  patchesDir: "patches",
  options: {
    namespace: "com.daytona.api",
    serviceName: "Daytona",
    skipDeprecated: true,
  },
});
