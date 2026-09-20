# TypeSafe for Distilled

Hand-maintained `POST /v1/systemone` and `GET /v1/models` operations, using
Distilled core's REST protocol, HTTP error categories, and Effect HttpClient.
Sources: https://docs.typesafe.ai/api and https://docs.typesafe.ai/models.
This small initial provider intentionally supports the string-instruction and
string-rubric subset used by Effect DecisionModel; it is not a generated full SDK.
There is no spec mirror or generator for this docs-derived subset.

Provide `Credentials` (redacted API key, base URL) and `HttpClient`. The env layer
uses `TYPESAFE_API_KEY` and optional `TYPESAFE_API_URL` (base ending in `/v1`).
Requests and responses are schema-validated. Caller owns scope/cancellation.
No automatic retries are made: evaluation can consume tokens. HTTP 401, 422,
429 and 529 surface through Distilled's auth/validation/throttling/server errors.
Cross-question/distribution validation is performed by Effect DecisionModel in
the consuming application, not by this low-level transport.

Version `0.0.0` is local development only; this package has **not** been released
or live-credential tested. Consumers must pack this checkout until a separately
approved release is available. From the Distilled root:

```sh
pnpm --filter @rikalabs/distilled-typesafe install --ignore-scripts --frozen-lockfile
pnpm --filter @rikalabs/distilled-typesafe run typecheck
bun test packages/typesafe/src
mkdir -p packages/typesafe/dist
npm pack ./packages/typesafe --pack-destination packages/typesafe/dist --ignore-scripts
```

The tarball contains TypeScript sources (no transpilation step is required by
Bun). Its only direct dependency is published `@rikalabs/distilled-core@1.0.0-rc.7`;
Effect is an exact `4.0.0-rc.116` peer. Install the tarball in the consuming
application instead of symlinking this separately installed checkout: Effect's
Redacted registry requires one physical Effect instance, not merely equal versions.
