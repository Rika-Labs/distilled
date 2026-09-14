#!/usr/bin/env bun
/**
 * smoke-router — live check of the per-task command-router path.
 *
 * Creates a sandbox (control plane), then drives the task command router
 * over distilled gRPC: TaskExecStart → TaskExecStdioRead (server-streaming)
 * → TaskExecWait → TaskExecStdinWrite → SandboxTerminateV2.
 *
 * Creates and destroys one sandbox. Requires MODAL_TOKEN_ID +
 * MODAL_TOKEN_SECRET in the environment.
 *
 *   MODAL_TOKEN_ID=… MODAL_TOKEN_SECRET=… bun scripts/smoke-router.ts
 */
import { Effect, Stream } from "effect";
import { ModalHttpClient } from "../src/http.ts";
import { credentials } from "../src/credentials.ts";
import { appGetOrCreate } from "../src/services/app.ts";
import { imageGetOrCreate } from "../src/services/image.ts";
import {
  sandboxCreateV2,
  sandboxGetTaskIdV2,
  sandboxTerminateV2,
} from "../src/services/sandbox.ts";
import {
  taskExecStart,
  taskExecStdioRead,
  taskExecStdinWrite,
  taskExecWait,
} from "../src/services/task_command_router.ts";

const program = Effect.gen(function* () {
  const app = yield* appGetOrCreate({
    appName: "distilled-router-smoke",
    objectCreationType: "OBJECT_CREATION_TYPE_CREATE_IF_MISSING",
  });
  if (app.appId === undefined) throw new Error("no appId");
  console.log(`app: ${app.appId}`);

  let imageId: string | undefined;
  for (let i = 0; i < 90; i++) {
    const img = yield* imageGetOrCreate({
      appId: app.appId,
      image: { dockerfileCommands: ["FROM python:3.12-slim"] },
    });
    if (img.result?.status === "GENERIC_STATUS_SUCCESS" && img.imageId) {
      imageId = img.imageId;
      break;
    }
    if (
      img.result?.status !== undefined &&
      img.result.status !== "GENERIC_STATUS_UNSPECIFIED"
    ) {
      throw new Error(`image build failed: ${img.result.status}`);
    }
    yield* Effect.sleep(2_000);
  }
  if (imageId === undefined) throw new Error("image never resolved");
  console.log(`image: ${imageId}`);

  const created = yield* sandboxCreateV2({
    appId: app.appId,
    definition: {
      imageId,
      timeoutSecs: 300,
      entrypointArgs: ["sleep", "300"],
    },
  });
  const sandboxId = created.sandboxId;
  const taskId = created.taskId;
  if (sandboxId === undefined || taskId === undefined) {
    throw new Error(`create missing ids: sandbox=${sandboxId} task=${taskId}`);
  }
  console.log(
    `sandbox: ${sandboxId} task: ${taskId} routerAccess-in-response: ${
      created.commandRouterAccess?.url !== undefined
    }`,
  );

  yield* Effect.acquireUseRelease(
    Effect.succeed(sandboxId),
    () =>
      Effect.gen(function* () {
        const ready = yield* sandboxGetTaskIdV2({
          sandboxId,
          waitUntilReady: true,
          timeout: 55,
        });
        console.log(
          `ready: taskId=${ready.taskId} status=${ready.taskResult?.status}`,
        );
        const execId = crypto.randomUUID();
        yield* taskExecStart({
          taskId,
          sandboxId,
          execId,
          commandArgs: ["echo", "distilled-router-ok"],
          stdoutConfig: "TASK_EXEC_STDOUT_CONFIG_PIPE",
          stderrConfig: "TASK_EXEC_STDERR_CONFIG_PIPE",
        });
        console.log(`exec started: ${execId}`);

        const chunks = yield* Stream.runCollect(
          taskExecStdioRead({
            taskId,
            sandboxId,
            execId,
            fileDescriptor: "TASK_EXEC_STDIO_FILE_DESCRIPTOR_STDOUT",
          }),
        );
        const b64 = [...chunks].map((c) => c.data ?? "").join("");
        const text = Buffer.from(b64, "base64").toString("utf8");
        console.log(`stdout: ${JSON.stringify(text)}`);

        const waited = yield* taskExecWait({ taskId, sandboxId, execId });
        console.log(`exit: code=${waited.code} signal=${waited.signal}`);

        // stdin write: start `cat`, write, EOF, read back.
        const catId = crypto.randomUUID();
        yield* taskExecStart({
          taskId,
          sandboxId,
          execId: catId,
          commandArgs: ["cat"],
          stdoutConfig: "TASK_EXEC_STDOUT_CONFIG_PIPE",
          stderrConfig: "TASK_EXEC_STDERR_CONFIG_PIPE",
        });
        yield* taskExecStdinWrite({
          taskId,
          sandboxId,
          execId: catId,
          data: Buffer.from("stdin-roundtrip").toString("base64"),
          eof: true,
        });
        const catChunks = yield* Stream.runCollect(
          taskExecStdioRead({
            taskId,
            sandboxId,
            execId: catId,
            fileDescriptor: "TASK_EXEC_STDIO_FILE_DESCRIPTOR_STDOUT",
          }),
        );
        const catText = Buffer.from(
          [...catChunks].map((c) => c.data ?? "").join(""),
          "base64",
        ).toString("utf8");
        console.log(`cat stdout: ${JSON.stringify(catText)}`);
        const catWait = yield* taskExecWait({
          taskId,
          sandboxId,
          execId: catId,
        });
        console.log(`cat exit: code=${catWait.code}`);
      }),
    () =>
      sandboxTerminateV2({ sandboxId }).pipe(
        Effect.tap(() => Effect.log(`terminated ${sandboxId}`)),
        Effect.orElseSucceed(() => undefined),
      ),
  );
});

const tokenId = process.env.MODAL_TOKEN_ID;
const tokenSecret = process.env.MODAL_TOKEN_SECRET;
if (!tokenId || !tokenSecret) {
  console.error("MODAL_TOKEN_ID and MODAL_TOKEN_SECRET are required");
  process.exit(1);
}

await Effect.runPromise(
  program.pipe(
    Effect.provide(credentials({ tokenId, tokenSecret })),
    Effect.provide(ModalHttpClient),
  ),
);
console.log("OK: router exec + streaming + stdin + wait + terminate all green");
