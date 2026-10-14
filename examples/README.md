# Examples

Two directories that look alike and are not. Read the difference before copying anything.

| Directory                                                 | What it is                                     | Copy from it?                           |
| --------------------------------------------------------- | ---------------------------------------------- | --------------------------------------- |
| [`crash-recovery/`](crash-recovery)                       | A supported example of using this library      | **Yes** — this is the recommended shape |
| [`conformance-reproductions/`](conformance-reproductions) | Reproductions of upstream behavior we reported | **No** — these demonstrate defects      |

## `crash-recovery/`

A real MCP server that starts a long task, is killed with `SIGKILL`, restarts, and answers the next `tasks/get` with the completed result. It tracks the supported dependency range and is updated with the library. If it stops showing the recommended way to use the package, that is a bug.

`demo.mts` runs the whole scenario in one command and asserts the outcome, so it fails loudly instead of printing a happy story. `server.mts` is the part worth reading: it serves `tasks/get`, `tasks/update` and `tasks/cancel` through handlers registered with an explicit schema, which `@modelcontextprotocol/server` 2.3.0 and later serve on a 2026-07-28 connection. It needs no middleware or transport rewrite.

## `conformance-reproductions/`

Minimal scripts that reproduce the upstream behavior recorded in [`docs/contract.md`](../docs/contract.md#extension-conformance-questions) and reported to the maintainers.

**They pin exact dependency versions on purpose.** An issue links to a script at a specific commit as evidence, and that link must keep meaning what it meant when it was reviewed. A bump is a deliberate re-measurement, not routine maintenance: it lands together with the new result in `docs/contract.md`. Earlier measurements stay at their tags. The `2.0.0` reproductions are at `v0.2.1`; the current ones pin server and client `2.3.1`. `schema.mts` reads the vendored schema instead of an SDK, and now measures the stable `2026-07-28` snapshot, where its issue is fixed. Its `draft`-era version is also at `v0.2.1`.

They are not patterns to follow. Where one shows a workaround, the workaround is described in the compatibility profile, not recommended here.

## Running them

Both are private workspace packages. Nothing here is published, and none of it reaches the tarball (`files` in the root `package.json` is an explicit list).

```sh
pnpm install
pnpm --filter mcp-durable-tasks-example-conformance run all
pnpm --filter mcp-durable-tasks-example-crash-recovery run demo
```

CI runs both on every pull request, with pinned versions and a lockfile. A failure means this repository changed something, not that upstream moved.
