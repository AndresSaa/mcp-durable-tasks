# Examples

Two directories that look similar and are not. Read the distinction before
copying anything out of here.

| Directory                                                 | What it is                                      | Copy from it?                           |
| --------------------------------------------------------- | ----------------------------------------------- | --------------------------------------- |
| [`crash-recovery/`](crash-recovery)                       | A supported example of using this library       | **Yes** — this is the recommended shape |
| [`conformance-reproductions/`](conformance-reproductions) | Reproductions of upstream behaviour we reported | **No** — these demonstrate defects      |

## `crash-recovery/` — living documentation

A real MCP server that starts a long task, is killed with `SIGKILL`, restarts,
and answers the next `tasks/get` with the completed result. It tracks the
supported dependency range and is updated as the library evolves. If it stops
representing the recommended way to use the package, that is a bug.

`demo.mts` drives the whole thing in one command and asserts the outcome, so
it is safe to record and it fails loudly rather than printing a happy story.
`server.mts` is the part worth reading: it serves `tasks/get`, `tasks/update`
and `tasks/cancel` through handlers registered with an explicit schema, the
form `@modelcontextprotocol/server` 2.3.0 and later serve on a 2026-07-28
connection, and it needs no middleware or transport rewrite.

## `conformance-reproductions/` — frozen evidence

Minimal scripts that reproduce the upstream behaviour recorded in
[`docs/contract.md`](../docs/contract.md#extension-conformance-questions) and
reported to the relevant maintainers.

**These pin exact dependency versions on purpose.** An issue links to a script
at a specific commit as its evidence, and that link has to keep meaning what it
meant when it was reviewed. A bump is therefore a deliberate re-measurement,
never routine maintenance: it lands together with the result it produced in
`docs/contract.md`, and the earlier measurement stays reachable at the commit
and tag it was published with. The `2.0.0` reproductions are at `v0.2.1`; the
current ones pin server and client `2.3.1`. `schema.mts` reads the vendored
schema rather than an SDK: it now measures the stable `2026-07-28` snapshot,
where the issue it reproduced is fixed, and its `draft`-era version is also at
`v0.2.1`.

They are not patterns to follow. Where a reproduction shows a workaround, the
workaround is described in the compatibility profile, not recommended here.

## Running them

Both are private workspace packages — nothing here is published, and none of it
reaches the tarball a consumer installs (`files` in the root `package.json` is
an explicit list).

```sh
pnpm install
pnpm --filter mcp-durable-tasks-example-conformance run all
pnpm --filter mcp-durable-tasks-example-crash-recovery run demo
```

CI runs both on every pull request, pinned, and a failure blocks the merge:
with versions and a lockfile fixed, a break means this repository changed
something, not that upstream moved.
