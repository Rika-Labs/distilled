#!/usr/bin/env bun
/**
 * smoke — read-only live check of the generated binary-gRPC path.
 *
 * Calls only `SandboxListV2` (and the AuthTokenGet exchange it triggers).
 * Creates/terminates nothing. Requires MODAL_TOKEN_ID + MODAL_TOKEN_SECRET
 * in the environment.
 *
 *   MODAL_TOKEN_ID=… MODAL_TOKEN_SECRET=… bun scripts/smoke.ts
 */
import { Effect } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { credentials } from "../src/credentials.ts";
import { sandboxListV2 } from "../src/services/sandbox.ts";

const program = Effect.gen(function* () {
  const res = yield* sandboxListV2({ includeFinished: true });
  return res;
});

const tokenId = process.env.MODAL_TOKEN_ID;
const tokenSecret = process.env.MODAL_TOKEN_SECRET;
if (!tokenId || !tokenSecret) {
  console.error("MODAL_TOKEN_ID and MODAL_TOKEN_SECRET are required");
  process.exit(1);
}

const out = await Effect.runPromise(
  program.pipe(
    Effect.provide(credentials({ tokenId, tokenSecret })),
    Effect.provide(FetchHttpClient.layer),
  ),
);

const sandboxes = (out as { sandboxes?: Array<Record<string, unknown>> })
  .sandboxes;
console.log(
  `OK: sandboxListV2 returned ${sandboxes?.length ?? 0} sandbox(es)` +
    (sandboxes?.[0]?.id ? ` — first id ${sandboxes[0].id}` : ""),
);
const first = sandboxes?.[0];
if (first) {
  const ti = first.taskInfo as Record<string, unknown> | undefined;
  console.log(
    `  fields: ${Object.keys(first).sort().join(", ")}` +
      `\n  taskInfo.status: ${JSON.stringify((ti?.result as Record<string, unknown> | undefined)?.status)}` +
      ` taskInfo.startedAt: ${JSON.stringify(ti?.startedAt)}` +
      ` createdAt: ${JSON.stringify(first.createdAt)}`,
  );
}
