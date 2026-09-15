# distilled (Rika Labs fork)

Effect-native SDKs for cloud providers, generated from their API
descriptions. This repository is a fork of
[alchemy-run/distilled](https://github.com/alchemy-run/distilled) that
republishes a subset of the SDKs under the `@rikalabs` npm scope with
Rika Labs modifications and additions.

## Packages

- `@rikalabs/distilled-core` — the smithy-to-Effect SDK compiler, codegen
  pipeline, protocol runtimes (REST, HTTP, gRPC/protobuf), traits,
  pagination, and retry machinery shared by every provider package.
- `@rikalabs/distilled-e2b` — E2B sandboxes: control-plane REST plus the
  per-sandbox envd surface (process, filesystem) over Connect-RPC.
- `@rikalabs/distilled-modal` — Modal: gRPC/protobuf transport with
  token exchange and server-streaming RPCs.
- `@rikalabs/distilled-vercel` — Vercel REST API.
- `@rikalabs/distilled-daytona` — Daytona sandboxes: control-plane and
  toolbox OpenAPI surfaces.
- `@rikalabs/distilled-cloudflare` — Cloudflare client-v4 API plus the
  `./Sandbox` bridge-worker subtree for Cloudflare Sandbox containers.

All packages are Effect-native: operations are `Effect` programs, schemas
are `effect/Schema`, and `effect` is a peer dependency.

## About this fork

Differences from upstream `alchemy-run/distilled`:

- The six packages above are renamed to the `@rikalabs/distilled-*` scope
  and depend on each other via workspace links; the remaining upstream
  `@distilled.cloud/*` packages are unchanged.
- `e2b`, `modal`, `vercel`, and `daytona` are hand-authored packages —
  wire-level protocol modules written by hand rather than generated from
  a public spec (`modal` is gRPC/protobuf).
- `cloudflare` gains the `./Sandbox` bridge-worker subtree for the
  Cloudflare Sandbox container API.
- Effect pin compatibility fixes for rc.112/rc.115
  (`Config.string`/`Config.String`, `Stream.filterMap` taking a `Filter`).
- Core additions needed by the packages above: a protobuf wire codec and
  unary binary gRPC protocol, and a per-request route hook for REST
  protocols.

Everything else is unchanged upstream code.

## License

Apache-2.0. Upstream code is copyright Functionless Corp.; modifications
and additions are copyright Rika Labs. See [NOTICE](./NOTICE) and
[THIRD_PARTY_LICENSES.md](./THIRD_PARTY_LICENSES.md).
