# Third-Party Licenses

Runtime dependencies of the published `@rikalabs/distilled-*` packages
(core, e2b, modal, vercel, daytona, cloudflare), with their licenses as
declared in each package's `package.json`.

| Package | Version | License | Homepage |
| --- | --- | --- | --- |
| graphql | 16.11.0 | MIT | https://github.com/graphql/graphql-js |
| effect | 4.0.0-rc.115 | MIT | https://effect.website |

Notes:

- `graphql` is a runtime dependency of `@rikalabs/distilled-core`.
- `effect` is a peer dependency of all six published packages; the version
  above is the catalog version resolved in this workspace.
- `@rikalabs/distilled-core` is itself a dependency of the other five
  packages; it is first-party to this repository (Apache-2.0) and is not
  listed above.
