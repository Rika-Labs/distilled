import { describe, expect, test } from "bun:test";
import { Effect, Redacted } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { Credentials, listModels, systemOne } from "./index.ts";

const request = {
  model: "jev-1.13.0",
  state: { file: "a.ts", changed: true },
  questions: { q: { type: "noul" as const, instructions: "Violation?" } },
};
const run = (status: number, body: unknown) =>
  Effect.runPromise(
    systemOne(request).pipe(
      Effect.provideService(Credentials, {
        apiKey: Redacted.make("test-key"),
        apiBaseUrl: "https://fixture.invalid/v1",
      }),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((req) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              req,
              new Response(JSON.stringify(body), { status }),
            ),
          ),
        ),
      ),
    ),
  );

describe("TypeSafe Distilled transport", () => {
  test("sends the documented body and auth, preserves typed usage", async () => {
    const output = await Effect.runPromise(
      systemOne(request).pipe(
        Effect.provideService(Credentials, {
          apiKey: Redacted.make("test-key"),
          apiBaseUrl: "https://fixture.invalid/v1/",
        }),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((req) => {
            expect(req.url).toBe("https://fixture.invalid/v1/systemone");
            expect(req.method).toBe("POST");
            expect(req.headers.authorization).toBe("Bearer test-key");
            expect(req.body._tag).toBe("Uint8Array");
            if (req.body._tag === "Uint8Array")
              expect(
                JSON.parse(new TextDecoder().decode(req.body.body)),
              ).toEqual(request);
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                req,
                new Response(
                  JSON.stringify({
                    model: request.model,
                    answers: { q: { type: "noul", noul: 0.81 } },
                    usage: { input_tokens: 17, output_tokens: 3 },
                  }),
                ),
              ),
            );
          }),
        ),
      ),
    );
    expect(output.usage).toEqual({ input_tokens: 17, output_tokens: 3 });
    expect(output.answers.q).toEqual({ type: "noul", noul: 0.81 });
  });
  test.each([
    [401, "Unauthorized"],
    [422, "UnprocessableEntity"],
    [429, "TooManyRequests"],
    [529, "InternalServerError"],
  ] as const)("HTTP %i fails with %s", async (status, tag) => {
    await expect(run(status, { message: "unavailable" })).rejects.toMatchObject(
      { _tag: tag },
    );
  });
  test.each([
    null,
    { model: "jev", answers: { q: { type: "noul", noul: 1.2 } } },
    { model: "jev", answers: {}, usage: { input_tokens: -1 } },
  ])("malformed success is never accepted: %j", async (body) => {
    await expect(run(200, body)).rejects.toMatchObject({ _tag: "SchemaError" });
  });
  test("lists models through the same credentials and REST protocol", async () => {
    const output = await Effect.runPromise(
      listModels().pipe(
        Effect.provideService(Credentials, {
          apiKey: Redacted.make("test-key"),
          apiBaseUrl: "https://fixture.invalid/v1",
        }),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((req) => {
            expect(req.method).toBe("GET");
            expect(req.url).toBe("https://fixture.invalid/v1/models");
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                req,
                new Response(
                  JSON.stringify({ models: [{ name: "jev-1.13.0" }] }),
                ),
              ),
            );
          }),
        ),
      ),
    );
    expect(output.models[0]?.name).toBe("jev-1.13.0");
  });
});
