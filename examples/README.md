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

## `conformance-reproductions/` — frozen evidence

Minimal scripts that reproduce the upstream behaviour recorded in
[`docs/contract.md`](../docs/contract.md#extension-conformance-questions) and
reported to the relevant maintainers.

**These pin exact dependency versions on purpose, and they stay pinned even
after upstream fixes the behaviour.** An issue links to a script at a specific
commit as its evidence; that link has to keep meaning what it meant when it was
reviewed. Upgrading these to make them "current" would quietly destroy the
record of what was measured.

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
something, not that upstream moved. A separate non-blocking job tracks a newer
SDK so drift is visible without holding up unrelated work.
