# daytona-spec

Spec mirror for the Daytona API.

Daytona publishes two documents on its docs site, neither versioned nor backed
by a git repository:

- `specs/openapi.json` — the control-plane API (OpenAPI 3.0), fetched from
  `https://www.daytona.io/docs/openapi.json`. Sandboxes, snapshots,
  organizations, toolbox proxy URLs.
- `specs/toolbox-openapi.json` — the per-sandbox Toolbox API (Swagger 2.0),
  fetched from `https://www.daytona.io/docs/toolbox-openapi.json`. The HTTP
  surface served by the daemon inside each sandbox: filesystem, process
  execution, PTY.

`bun run fetch-specs.ts` refreshes both.
