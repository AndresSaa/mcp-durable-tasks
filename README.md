# ![mcp-durable-tasks — durable, resumable task state for MCP servers](https://raw.githubusercontent.com/AndresSaa/mcp-durable-tasks/main/.github/assets/readme-banner.webp)

[![CI](https://github.com/AndresSaa/mcp-durable-tasks/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/AndresSaa/mcp-durable-tasks/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/mcp-durable-tasks?logo=npm&color=cb3837)](https://www.npmjs.com/package/mcp-durable-tasks)
[![MCP Tasks](https://img.shields.io/badge/MCP_Tasks-SEP--2663-7c3aed)](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2663-tasks-extension.md)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933?logo=nodedotjs&logoColor=white)](https://github.com/AndresSaa/mcp-durable-tasks/blob/main/package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-pure-3178C6?logo=typescript&logoColor=white)](https://github.com/AndresSaa/mcp-durable-tasks/tree/main/src)
[![Runtime dependencies](https://img.shields.io/badge/runtime_dependencies-0-2ea44f)](https://github.com/AndresSaa/mcp-durable-tasks/blob/main/package.json)
[![Modules](https://img.shields.io/badge/modules-ESM%20%2B%20CJS-7c3aed)](https://github.com/AndresSaa/mcp-durable-tasks/blob/main/package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/AndresSaa/mcp-durable-tasks/blob/main/LICENSE)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/AndresSaa/mcp-durable-tasks/badge)](https://scorecard.dev/viewer/?uri=github.com/AndresSaa/mcp-durable-tasks)

**A durable task state machine for the MCP Tasks extension
(`io.modelcontextprotocol/tasks`, SEP-2663).** Zero runtime dependencies, pure
TypeScript, one job: hold a long-running operation's state so `tasks/get` can
still answer after the worker, the connection, or the whole process has gone.

This is **a library you import into an MCP server** — not a server you add to
`mcp.json`, and not a to-do manager. "Tasks" here means the extension's durable
task handles: the thing a server returns instead of blocking on work that takes
minutes.

```ts
import { TaskLifecycle, MemoryTaskStore } from "mcp-durable-tasks";

const tasks = new TaskLifecycle({ store: new MemoryTaskStore() });

// tools/call decides to defer: hand back a task instead of a result.
const created = await tasks.createTask({ ttlMs: 3_600_000 });
runTheWork(tasks.handle(created.taskId)); // not awaited

// tasks/get, later, possibly from another connection.
const view = await tasks.getTask(created.taskId);
```

The worker writes through the handle:

```ts
async function runTheWork(task) {
  await task.progress("indexing", { pollIntervalMs: 2_000 });
  if (task.signal.aborted) return task.cancelled("client cancelled");
  await task.complete({ content: [{ type: "text", text: "done" }] });
}
```

## Before you adopt it

**`WalTaskStore` is for one process and one disk.** It inherits
[`process-wal`](https://github.com/AndresSaa/process-wal)'s single-writer
contract: two processes on the same directory corrupt the log. That fits stdio
MCP servers — Claude Code, Cursor, VS Code, a local Codex — which is where the
genuinely long tasks live: builds, test suites, migrations, indexing. For a
stateless HTTP server behind a load balancer, implement `TaskStore` over your
shared database; it is five methods, and `mcp-durable-tasks/testing` gives you
the test suite before you write the first one.

**Worker coordination has process affinity.** `TaskStore` compare-and-swap
protects the durable record when several instances can write it, but the
promise `requestInput()` returns and the cancellation signal belong to the
process running that worker. While a worker is live, `tasks/update` and
`tasks/cancel` have to reach that instance — sticky routing, or coordination
you provide. This library deliberately does not embed a broker or a queue. The
specification does not define that delivery mechanism either; see
[the process-boundary contract](docs/contract.md#process-boundaries).

## Contents

- [Before you adopt it](#before-you-adopt-it)
- [Status](#status)
- [Install](#install)
- [Documentation](#documentation)
- [Official references](#official-references)
- [What survives what](#what-survives-what)
- [See it survive a crash](#see-it-survive-a-crash)
- [Known gap in the official SDK](#known-gap-in-the-official-sdk)
- [Writing your own store](#writing-your-own-store)
- [Development](#development)
- [License](#license)

## Status

The codebase is ready for `v0.1.0`: the engine, both included stores, the
conformance kit and the crash tests are in place. This is also the first npm
release. Its registry publication is deliberately manual; later versions are
published from GitHub Actions with trusted publishing and provenance.

The public API remains provisional until `1.0.0`; the version roadmap and open
extension questions live in
[the contract and conformance profile](docs/contract.md).

## Install

Requires Node.js 22 or newer.

The library supports Node.js 22 from its first release; working from source
uses the pinned pnpm 11 toolchain and therefore needs Node.js 22.13 or newer.

To install the first registry release:

```sh
pnpm add mcp-durable-tasks
```

To validate the exact tag from source instead:

```sh
git clone https://github.com/AndresSaa/mcp-durable-tasks.git
cd mcp-durable-tasks
git checkout v0.1.0
corepack pnpm install --frozen-lockfile
corepack pnpm test
```

`process-wal` is an **optional peer dependency**, needed only by the `/wal`
entry point. Nothing else in the package requires it:

```sh
pnpm add mcp-durable-tasks process-wal
```

| Entry point                 | What it holds                        | Needs         |
| --------------------------- | ------------------------------------ | ------------- |
| `mcp-durable-tasks`         | the engine, `MemoryTaskStore`, types | nothing       |
| `mcp-durable-tasks/wal`     | `WalTaskStore`                       | `process-wal` |
| `mcp-durable-tasks/testing` | the store conformance kit            | nothing       |

The main entry point uses no Node built-ins, so the engine and
`MemoryTaskStore` run in web-standard runtimes too.

## Documentation

- [**API**](docs/api.md) — every option, method and error
- [Durability](docs/durability.md) — what survives what, and the two
  unsupported configurations
- [Internals](docs/internals.md) — design decisions and source layout
- [Contract and conformance](docs/contract.md) — scope, invariants, SDK
  compatibility findings and open extension questions

## Official references

- [MCP Tasks extension overview](https://tasks.extensions.modelcontextprotocol.io/)
- [Tasks extension draft specification](https://tasks.extensions.modelcontextprotocol.io/specification/draft/tasks.html)
- [SEP-2663 proposal](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2663-tasks-extension.md)
- [Official schema and TypeScript types](https://github.com/modelcontextprotocol/ext-tasks/tree/main/schema)
- [TypeScript SDK v2 migration notes for protocol revision 2026-07-28](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28)

## What survives what

`WalTaskStore` writes every mutation to a write-ahead log before returning, and
replays it on open. A returned `createTask()` means the task is already durable
— the extension states that normatively, and it is the invariant this package
exists for.

Automatic compaction happens only after the triggering mutation is durable. A
compaction failure therefore does not turn that committed mutation into a
rejection. Pass `onCompactionError` to observe it. The event says whether the
underlying WAL became unusable; in that case the committed call still returns,
and the next store operation fails with `ERR_WAL_UNUSABLE` so the host can close
and reopen the store for recovery.

WAL entries are bounded, not unbounded. `WalTaskStore` defaults
`maxEntryBytes` to **8 MiB per encoded task record** (including its envelope
and metadata): enough for roughly 100,000 ordinary 80-byte build-log lines,
while keeping synchronous JSON encoding and snapshot compaction under a hard
per-task ceiling. Set a different limit when your workload warrants it.

An oversized mutation does not commit and throws `TaskEntryTooLargeError`,
whose stable `code` is `ERR_ENTRY_TOO_LARGE`. A worker can therefore preserve
its completed work by retrying the terminal transition with a summary or
truncated result:

```ts
import { isTaskEntryTooLargeError } from "mcp-durable-tasks";

try {
  await task.complete(fullResult);
} catch (error) {
  if (!isTaskEntryTooLargeError(error)) throw error;
  await task.complete({ truncated: true, summary: summarize(fullResult) });
}
```

Raising the limit only moves this failure boundary; it never removes it.
Use the predicate rather than `instanceof`: duplicated npm packages and the
separate CJS entry bundles do not guarantee shared class identity.

Task results, errors, and input payloads are recursively validated as plain JSON
before state changes. Values such as `Map`, `Date`, `bigint`, functions, cycles,
array holes, and non-finite numbers are rejected consistently by both stores;
the in-memory view can therefore never differ from the value replayed from WAL.
JavaScript's `-0` is valid JSON, so it is accepted and canonicalised to `0`
before mutation; it is the only accepted finite number whose identity changes
through `JSON.stringify`/`JSON.parse`.
The input round-trip additionally validates the full MCP shape before a write:
sampling content must be one of its discriminated text, image, audio, tool-use
or tool-result blocks; elicitation schemas stay within MCP's primitive subset;
URL elicitation requires an opaque id and a valid URL; roots use `file://`;
binary blocks are Base64; and accepted elicitation values are primitives or
string arrays. These rules are pinned to the
[`@modelcontextprotocol/sdk@1.30.0` source](https://github.com/modelcontextprotocol/typescript-sdk/blob/1.30.0/src/types.ts),
not inferred from the lossy generated extension schema. A JSON object is not
accepted merely because it is serialisable.

| Mode                     | Process crash, `SIGKILL`, restart | Host or power loss             |
| ------------------------ | --------------------------------- | ------------------------------ |
| `fsync: false` (default) | Recoverable                       | Not guaranteed                 |
| `fsync: true`            | Recoverable                       | Requests a storage flush first |

The left column is tested, not asserted: `test/crash.test.ts` runs real child
processes, kills them with `SIGKILL` at a known state, and reopens the
directory. A task created and never touched again comes back as `working`; one
parked on input comes back with its requests and its used-key ledger intact, so
the restarted process still refuses to reuse a key the dead one issued; a task
completed the instant before the signal keeps its result; an acknowledged
progress version is a hard lower bound after a kill in later appends; and a
confirmed multi-task snapshot survives a kill in a compaction loop. Those tests
load `dist/`, so what is proven to recover is the package you install.

The deterministic examples are backed by a fast-check state-machine model:
random schedules combine progress, TTL changes and clock rollback, partial and
duplicate input responses, cancellation, terminal races and injected CAS
conflicts. Every step compares the full record, closed wire projection and
single-settlement worker effects against an independent reference state.

## See it survive a crash

`examples/crash-recovery/` is a real MCP server whose task outlives the
process. One command starts it, defers work through `tools/call`, kills the
server with `SIGKILL`, starts it again, and reads the finished result back
from the new process:

```sh
pnpm --filter mcp-durable-tasks-example-crash-recovery run demo
```

[![Watch the crash-recovery demo](https://asciinema.org/a/U0DD3KWEttwhv5g5.svg)](https://asciinema.org/a/U0DD3KWEttwhv5g5)

The recording above runs the example from a clean checkout. Its essential
output is also included below for text-only readers:

```
3. Kill the server outright — SIGKILL, no shutdown hook, no flush
   process gone. Whatever is on disk is all there is.

5. Ask the new process for the task the dead one finished
   tasks/get → completed
   result   → {"content":[{"type":"text","text":"indexed 5 files, 0 errors"}], ...}
```

It runs on every pull request, so it cannot quietly stop being true. The
server also shows the one workaround a host needs today — see the next section.

## Known gap in the official SDK

On a `2026-07-28` server built with `@modelcontextprotocol/server` v2, **two of
the extension's three methods cannot be served at all.** `tasks/get` and
`tasks/cancel` answer `-32601` before any handler runs — including
`fallbackRequestHandler` — because both names belong to the retired
`2025-11-25` method registry and the protocol-era gate fires on the way in.
`tasks/update` works, because SEP-2663 introduced it and no era claims the name.

This is measured, not inferred; the environment and findings are in the
[compatibility profile](docs/contract.md#typescript-sdk-v2-compatibility). The
only verified workaround is renaming those two methods below `Protocol`, at the
transport seam.

## Writing your own store

`TaskStore` is five methods, and you do not have to guess whether yours is
correct — the conformance kit ships with the package:

```ts
import { describe, it } from "vitest";
import { runTaskStoreConformance } from "mcp-durable-tasks/testing";

runTaskStoreConformance(
  "RedisTaskStore",
  () => ({
    store: new RedisTaskStore({ url }),
    reopen: () => new RedisTaskStore({ url }),
  }),
  {
    runner: {
      describe,
      it,
      skip: (context, reason) =>
        (context as { skip(reason?: string): void }).skip(reason),
    },
  },
);
```

It has no dependencies and no opinion about your test runner; pass `describe`
and `it` from whichever you use. If you would rather not involve one at all,
`checkTaskStore(name, factory)` runs the same checks and hands back a report.

The factory is called once per check and must return a fresh store each time;
the kit rejects a reused instance. Give it an `advanceTime(ms)` if your store
has a clock seam, and `reopen()` if a new instance can reconnect to the same
backing data. Without those seams, the TTL or cross-instance durability checks
are reported as skipped rather than quietly passing. Runner integrations must
provide `runner.skip(context, reason)` to record a real skip; if they do not,
a missing optional seam fails with an actionable message instead of producing
a false green. The reopen path exercises a full partial-input round and proves
that live request/response maps are cleared while `usedInputKeys` remains
durable across both reopen boundaries.

Every factory, check, `close()` and `dispose()` operation has a 10-second
deadline by default (`timeoutMs` changes it). Cleanup failures are check
failures; they are never swallowed.

`TaskPatch` follows ordinary object-spread visibility: only enumerable own
string-keyed properties participate. For those properties, `undefined` means
delete rather than leave unchanged; the kit pins both parts of that rule.

Publish it, open an issue, and it gets linked from these docs.

## Development

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm lint
corepack pnpm test
corepack pnpm coverage
corepack pnpm lint:package   # packs, installs and imports the real tarball
corepack pnpm check:schema   # compares the vendored schema against upstream
```

## License

MIT
