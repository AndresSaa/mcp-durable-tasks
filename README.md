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

**A library you import into an MCP server to keep durable task state for the
MCP Tasks extension (`io.modelcontextprotocol/tasks`, SEP-2663).** It is a task
state machine written in TypeScript, with no runtime dependencies on its main
entry point. With `WalTaskStore`, any state your application has already
confirmed is still available to `tasks/get` after the connection, or the whole
process, is gone.

It is not a server you add to `mcp.json`, and it is not a to-do manager. In this
project, a "task" is the extension's durable task handle: what a server returns
when the work takes minutes and it should not block.

It is the server-side counterpart of the official
[`@modelcontextprotocol/ext-tasks`](https://www.npmjs.com/package/@modelcontextprotocol/ext-tasks)
package. The client calls a tool, polls the task and answers its input requests
through that package's `/client` entry point. The server uses this library to
create the task, store its state and answer `tasks/get`, `tasks/update` and
`tasks/cancel`. It targets the stable `2026-07-28` revision of the extension.

```ts
import { TaskLifecycle, MemoryTaskStore } from "mcp-durable-tasks";

const tasks = new TaskLifecycle({ store: new MemoryTaskStore() });

// In tools/call: return a task instead of a result.
const created = await tasks.createTask({ ttlMs: 3_600_000 });
runTheWork(tasks.handle(created.taskId)); // not awaited

// Later, in tasks/get (possibly from another connection).
const view = await tasks.getTask(created.taskId);
```

The worker writes its progress through the handle:

```ts
async function runTheWork(task) {
  await task.progress("indexing", { pollIntervalMs: 2_000 });
  if (task.signal.aborted) return task.cancelled("client cancelled");
  await task.complete({ content: [{ type: "text", text: "done" }] });
}
```

## Before you adopt it

**`WalTaskStore` works for one process and one disk.** It uses
[`process-wal`](https://github.com/AndresSaa/process-wal), which allows a single
writer. If two processes open the same directory, the log gets corrupted. This
fits MCP servers that run over stdio, such as those started by Claude Code,
Cursor or VS Code. That is also where long tasks are common: builds, test
suites, migrations and indexing. If your server is stateless and sits behind a
load balancer, implement `TaskStore` on top of your shared database. It has
five methods, and `mcp-durable-tasks/testing` gives you a test suite to run
before you write the first one.

**A running worker belongs to one process.** Compare-and-swap on the store
protects the saved record when several instances can write it. But the promise
that `requestInput()` returns, and the cancellation signal, live in the process
that runs the worker. While that worker is running, `tasks/update` and
`tasks/cancel` must reach the same instance.

The extension expects this setup. Over Streamable HTTP, the client sends the
task ID in an `Mcp-Name` header on every `tasks/get`, `tasks/update` and
`tasks/cancel`, so a load balancer can send each request to the instance that
holds the task. You configure that routing in your HTTP layer. This library does
not read headers, and it does not include a broker or a queue. See
[the process-boundary contract](docs/contract.md#process-boundaries).

## Contents

- [Before you adopt it](#before-you-adopt-it)
- [Status](#status)
- [Install](#install)
- [Documentation](#documentation)
- [Official references](#official-references)
- [What survives what](#what-survives-what)
- [See it survive a crash](#see-it-survive-a-crash)
- [The official SDK's era gate](#the-official-sdks-era-gate)
- [Writing your own store](#writing-your-own-store)
- [Development](#development)
- [License](#license)

## Status

The current release is `v0.3.0`. It includes the engine, both stores, the
public conformance kit, property-based state-machine tests, real crash tests and
a runnable crash-recovery example. Since `v0.2.0`, releases are published from
GitHub Actions with npm trusted publishing, and each one has a provenance
attestation tied to its tag and commit.

`v0.3.0` hardens the engine after an independent audit and aligns its input
validation with the stable `2026-07-28` schema. It contains breaking changes.
Before `1.0.0`, semver treats those as a minor release. The
[changelog](CHANGELOG.md) lists each change and the known issues that are still
open.

`v0.1.0` was published to npm by hand, once, to create the package on the
registry. No later release uses a long-lived npm token.

The public API may still change before `1.0.0`. The version roadmap and the open
questions about the extension are in
[the contract and conformance profile](docs/contract.md). The next planned
feature is not built yet: a change emitter for the optional `notifications/tasks`
message. The engine emits each committed change, and the host delivers it. This
package has no client entry point and none is planned. For the client side, use
`@modelcontextprotocol/ext-tasks/client`.

## Install

Requires Node.js 22 or newer.

To work from source, you need Node.js 22.13 or newer, because the repository
pins pnpm 11.

Install the latest release from the registry:

```sh
pnpm add mcp-durable-tasks
```

To check out an exact release and run its tests instead:

```sh
git clone https://github.com/AndresSaa/mcp-durable-tasks.git
cd mcp-durable-tasks
git checkout v0.3.0
corepack pnpm install --frozen-lockfile
corepack pnpm test
```

`process-wal` is an **optional peer dependency**. Only the `/wal` entry point
needs it:

```sh
pnpm add mcp-durable-tasks process-wal
```

| Entry point                 | What it contains                     | Needs         |
| --------------------------- | ------------------------------------ | ------------- |
| `mcp-durable-tasks`         | the engine, `MemoryTaskStore`, types | nothing       |
| `mcp-durable-tasks/wal`     | `WalTaskStore`                       | `process-wal` |
| `mcp-durable-tasks/testing` | the store conformance kit            | nothing       |

The main entry point uses no Node built-ins. The engine and `MemoryTaskStore`
can therefore also run in web-standard runtimes.

## Documentation

- [**API**](docs/api.md): every option, method and error
- [Durability](docs/durability.md): what survives what, and the two
  unsupported configurations
- [Internals](docs/internals.md): design decisions and source layout
- [Contract and conformance](docs/contract.md): scope, invariants, SDK
  compatibility findings and open questions about the extension

## Official references

- [MCP Tasks extension overview](https://tasks.extensions.modelcontextprotocol.io/)
- [Tasks extension specification, revision 2026-07-28](https://tasks.extensions.modelcontextprotocol.io/specification/2026-07-28/tasks.html)
- [SEP-2663 proposal](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2663-tasks-extension.md)
- [Official schema for revision 2026-07-28](https://github.com/modelcontextprotocol/ext-tasks/blob/main/schema/2026-07-28/schema.json)
- [`@modelcontextprotocol/ext-tasks`](https://www.npmjs.com/package/@modelcontextprotocol/ext-tasks),
  the official client-side package
- [TypeScript SDK v2 migration notes for protocol revision 2026-07-28](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28)

## What survives what

`WalTaskStore` writes every change to a write-ahead log before it returns, and
replays the log when it opens. When `createTask()` returns, the task is already
on disk. The extension requires this, and it is the main guarantee of this
package.

Compaction runs automatically, and only after the change that triggered it is
saved. If compaction fails, the change that triggered it is still committed and
does not turn into an error. Pass `onCompactionError` to be notified. The event
tells you whether the underlying log can still be used. If it cannot, the call
that triggered it still returns, and the next store operation fails with
`ERR_WAL_UNUSABLE`. At that point, close and reopen the store to recover.

Each log entry has a size limit. `WalTaskStore` sets `maxEntryBytes` to **8 MiB
per encoded task record** by default, including its envelope and metadata. That
is enough for about 100,000 build-log lines of 80 bytes each. The limit also
keeps JSON encoding and compaction bounded for each task. You can set a
different limit if your workload needs it.

A change that is too large is not committed, and it throws
`TaskEntryTooLargeError`. Its `code` is `ERR_ENTRY_TOO_LARGE`. A worker can keep
its finished work by retrying the final step with a summary or a truncated
result:

```ts
import { isTaskEntryTooLargeError } from "mcp-durable-tasks";

try {
  await task.complete(fullResult);
} catch (error) {
  if (!isTaskEntryTooLargeError(error)) throw error;
  await task.complete({ truncated: true, summary: summarize(fullResult) });
}
```

A higher limit only moves the point where this error happens. Use the predicate
instead of `instanceof`. If npm installs the package twice, or you load both the
CJS and ESM builds, the two copies do not share the same error class.

Results, errors and input payloads must be plain JSON, and both stores check
this before they change any state. They reject `Map`, `Date`, `bigint`,
functions, cycles, array holes and non-finite numbers. So the value in memory
always matches the value replayed from the log. JavaScript's `-0` is valid JSON,
so it is accepted and stored as `0`. It is the only finite number that changes
identity in a `JSON.stringify` and `JSON.parse` round trip.

The input round also checks the full MCP shape of each request and response
before it writes anything:

- Sampling content must be a text, image, audio, tool-use or tool-result block.
- Elicitation schemas must stay within MCP's primitive types.
- URL elicitation needs a valid URL, roots use `file://`, and binary content is
  Base64.
- Accepted elicitation values are primitives or arrays of strings.

These rules were first written from the
[`@modelcontextprotocol/sdk@1.30.0` source](https://github.com/modelcontextprotocol/typescript-sdk/blob/1.30.0/src/types.ts)
and are tested against the stable `2026-07-28` schema. Three of those SDK rules
refused shapes that `2026-07-28` allows: URL elicitation without
`elicitationId`, a tool `outputSchema` that is not an object at its root, and
`structuredContent` that is not an object. They now follow `2026-07-28`. The
[contract](docs/contract.md#input-rounds) lists the remaining differences.

`fail()` takes a JSON-RPC error object, as the schema requires: an integer
`code` and a string `message`, with optional `data`. Anything else throws
`TypeError` and nothing is written
([contract](docs/contract.md#wire-contract)).

| Mode                     | Process crash, `SIGKILL`, restart | Host or power loss             |
| ------------------------ | --------------------------------- | ------------------------------ |
| `fsync: false` (default) | Recoverable                       | Not guaranteed                 |
| `fsync: true`            | Recoverable                       | Requests a storage flush first |

The left column is tested. `test/crash.test.ts` starts real child processes,
kills them with `SIGKILL` at a known state and reopens the directory:

- A task that was created and never touched again comes back as `working`.
- A task that was waiting for input comes back with its requests and its list of
  used keys. The restarted process still cannot reuse a key that the dead
  process issued.
- A client reply that completes a round while no worker is running is kept, across further kills, until one restarted worker claims it with `resumeInput()`.
- A task completed just before the kill keeps its result.
- A progress version that was acknowledged is never lost, even if the process is
  killed during later writes.
- A confirmed snapshot of several tasks survives a kill during compaction.

These tests load `dist/`, so they check the package that you install.

The worker's suspended `requestInput()` call does not survive a restart, but the answers do. A restarted worker calls `task.resumeInput()` first: it returns the responses that arrived while no worker was waiting, exactly once, or `undefined`. If the client has not answered yet, the reply is kept the same way when it arrives, so the worker can call `resumeInput()` again later, or ask again with new keys; the old keys stay spent ([durability](docs/durability.md#what-durability-does-not-cover)).

A state-machine model built with fast-check backs these examples. Random
schedules combine progress updates, TTL changes, clock rollbacks, partial and
duplicate input responses, cancellation, races at the terminal state and
injected CAS conflicts. After every step, the test compares the full record, the
closed wire projection and the worker effects against an independent reference.

## See it survive a crash

`examples/crash-recovery/` is a real MCP server whose task outlives its process.
One command starts the server and defers work through `tools/call`. It then kills
the server with `SIGKILL`, starts it again and reads the finished result from the
new process:

```sh
pnpm --filter mcp-durable-tasks-example-crash-recovery run demo
```

[![Watch the crash-recovery demo](https://asciinema.org/a/U0DD3KWEttwhv5g5.svg)](https://asciinema.org/a/U0DD3KWEttwhv5g5)

The recording runs the example from a clean checkout. The key output is also
here as text:

```
3. Kill the server outright — SIGKILL, no shutdown hook, no flush
   process gone. Whatever is on disk is all there is.

5. Ask the new process for the task the dead one finished
   tasks/get → completed
   result   → {"content":[{"type":"text","text":"indexed 5 files, 0 errors"}], ...}
```

The demo runs on every pull request, so it stays accurate. It also shows how to
serve `tasks/*` through the official SDK, which the next section explains.

## The official SDK's era gate

Before `@modelcontextprotocol/server` 2.3.0, a `2026-07-28` server **could not
serve two of the extension's three methods through the SDK's registered
handlers.** `tasks/get` and `tasks/cancel` returned `-32601` before any handler
ran, including `fallbackRequestHandler`. Both names belong to the retired
`2025-11-25` method registry, and the SDK's protocol-era gate rejected them on
the way in. `tasks/update` worked, because SEP-2663 introduced that name and no
earlier era claims it. This was measured with 2.0.0. The environment and the
results are in the
[compatibility profile](docs/contract.md#typescript-sdk-v2-compatibility).

The gate is fixed upstream
([typescript-sdk#2599](https://github.com/modelcontextprotocol/typescript-sdk/pull/2599),
which closes [#2598](https://github.com/modelcontextprotocol/typescript-sdk/issues/2598)).
We measured it with `@modelcontextprotocol/server` 2.3.1. Handlers registered
with an explicit schema, using `setRequestHandler(method, schemas, handler)`,
serve all three methods. Typed registration and `fallbackRequestHandler` still
return `-32601` for `tasks/get` and `tasks/cancel`.

The crash-recovery example requires `server` `^2.3.0` and registers the three
methods in that way, with no middleware and no transport rewrite. It also shows
two details that are easy to miss:

- The SDK rejects a task request when the `Mcp-Name` header does not match
  `params.taskId`. It returns `-32020`, before any handler runs.
- On a `2026-07-28` request, the SDK moves `params.inputResponses` to
  `ctx.mcpReq.inputResponses`. A `tasks/update` handler must read it from there.

If your server uses a version before 2.3.0, you still need a narrow workaround.
The profile lists the two that we verified on 2.0.0.

## Writing your own store

`TaskStore` has five methods. You do not need to guess whether your
implementation is correct, because the conformance kit is part of the package:

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

The kit has no dependencies and works with any test runner. Pass the `describe`
and `it` functions of the runner you use. If you prefer not to use a runner,
`checkTaskStore(name, factory)` runs the same checks and returns a report.

The factory runs once per check and must return a new store each time. The kit
rejects a store instance that is reused. Add these optional parts if your store
supports them:

- `advanceTime(ms)`, if your store has a clock you can control. Also add
  `now()`, which returns the time of that clock, unless the clock starts at
  `2026-01-01T00:00:00Z`.
- `reopen()`, if a new instance can reconnect to the same stored data.

Without them, the kit reports the TTL checks or the cross-instance durability
checks as skipped. It does not let them pass silently. To record a real skip,
your runner integration must provide `runner.skip(context, reason)`. If it does
not, a missing optional part fails with a clear message, so you never get a
false pass. The reopen checks run a full partial-input round. They confirm that
the live request and response maps are cleared, and that `usedInputKeys` stays
saved across both reopen steps. The kit also checks that `unclaimedInputResponses` is stored, re-read and replayed like every other field, so a store that keeps only a fixed list of fields fails.

Every factory call, check, `close()` and `dispose()` has a 10-second limit by
default. Change it with `timeoutMs`. A failure during cleanup counts as a failed
check, and the kit never hides it.

`TaskPatch` follows the visibility rules of object spread. Only enumerable own
properties with string keys count. For those properties, `undefined` means
"delete the field", not "leave it unchanged". The kit tests both parts of this
rule.

If you publish a store, open an issue and we can link it from these docs.

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
