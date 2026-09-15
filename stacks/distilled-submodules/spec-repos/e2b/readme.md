# spec-mirror-e2b

A git mirror of E2B's API descriptions from
[e2b-dev/infra](https://github.com/e2b-dev/infra), reduced to exactly the
files the [`@rikalabs/distilled-e2b`](https://github.com/Rika-Labs/distilled)
generator reads:

- `specs/openapi.yml` — `spec/openapi.yml`: the control-plane OpenAPI 3.0
  document (sandbox lifecycle, templates, api-keys, volumes, secrets, events)
- `specs/envd.yaml` — `packages/envd/spec/envd.yaml`: the per-sandbox envd
  REST API (file upload/download, env vars, health, metrics)
- `specs/process.proto` — `packages/envd/spec/process/process.proto`: the
  envd `process.Process` connect-RPC service
- `specs/filesystem.proto` — `packages/envd/spec/filesystem/filesystem.proto`:
  the envd `filesystem.Filesystem` connect-RPC service

Nothing else from `infra` is mirrored, so this repository stays small enough
to use as a git submodule — the upstream repository is never cloned.

The mirror is updated every 24 hours by
[`.github/workflows/update-specs.yml`](./.github/workflows/update-specs.yml).

## Usage as a submodule

```sh
git submodule add https://github.com/distilled-mirror/spec-mirror-e2b.git
```

## Updating specs

From `.meta/`:

```sh
bun install
bun run fetch-specs
```

---

This repository is managed by the `distilled-submodules` Alchemy stack in
[Rika-Labs/distilled](https://github.com/Rika-Labs/distilled)
(`stacks/distilled-submodules`). Its scaffolding is generated — edit it
there, not here.
