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

**A library you import into an MCP server to keep durable task state for the MCP Tasks extension (`io.modelcontextprotocol/tasks`, SEP-2663).** It is not a server you add to `mcp.json`, and it is not a to-do manager. A "task" here is the extension's durable task handle: what a server returns when the work takes minutes and should not block.

It is a task state machine in TypeScript, with no runtime dependencies on its main entry point. With `WalTaskStore`, any state your application has already confirmed is still available to `tasks/get` after the connection, or the whole process, is gone.

It is the server-side counterpart of the official [`@modelcontextprotocol/ext-tasks`](https://www.npmjs.com/package/@modelcontextprotocol/ext-tasks) package. The client calls a tool, polls the task and answers its input requests through that package's `/client` entry point. The server uses this library to create the task, store its state and answer `tasks/get`, `tasks/update` and `tasks/cancel`. It targets the stable `2026-07-28` revision.

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

**`WalTaskStore` works for one process and one disk.** It uses [`process-wal`](https://github.com/AndresSaa/process-wal), which allows a single writer: if two processes open the same directory, the log gets corrupted. That fits MCP servers over stdio (Claude Code, Cursor, VS Code), where long tasks such as builds, test suites and migrations are common. If your server is stateless behind a load balancer, implement `TaskStore` on your shared database. It has five methods, and `mcp-durable-tasks/testing` gives you tests to run against it.

**A running worker belongs to one process.** Compare-and-swap protects the saved record, but the promise that `requestInput()` returns and the cancellation signal live in the process that runs the worker. While it runs, `tasks/update` and `tasks/cancel` must reach that same instance.

Over Streamable HTTP, the client sends the task ID in an `Mcp-Name` header on every `tasks/get`, `tasks/update` and `tasks/cancel`, so a load balancer can route on it. You set that up in your HTTP layer; this library does not read headers and has no broker or queue. See [process boundaries](docs/contract.md#process-boundaries).

## Status

The current release is `v0.4.0`: the engine, both stores, the conformance kit, property-based and crash tests, and a runnable crash-recovery example. Before `1.0.0`, breaking changes ship as minor releases and the public API may still change; the [changelog](CHANGELOG.md) lists them. The roadmap and the open questions about the extension are in the [contract](docs/contract.md).

Not built yet: a change emitter for the optional `notifications/tasks` message (the engine emits each committed change, the host delivers it). There is no client entry point and none is planned; use `@modelcontextprotocol/ext-tasks/client`.

## Install

Requires Node.js 22 or newer.

```sh
pnpm add mcp-durable-tasks
```

`process-wal` is an optional peer dependency. Only the `/wal` entry point needs it:

```sh
pnpm add mcp-durable-tasks process-wal
```

| Entry point                 | What it contains                     | Needs         |
| --------------------------- | ------------------------------------ | ------------- |
| `mcp-durable-tasks`         | the engine, `MemoryTaskStore`, types | nothing       |
| `mcp-durable-tasks/wal`     | `WalTaskStore`                       | `process-wal` |
| `mcp-durable-tasks/testing` | the store conformance kit            | nothing       |

The main entry point uses no Node built-ins, so the engine and `MemoryTaskStore` also run in web-standard runtimes.

## Documentation

- [**API**](docs/api.md): every option, method and error
- [Durability](docs/durability.md): what survives what, and the two unsupported configurations
- [Internals](docs/internals.md): design decisions and source layout
- [Contract and conformance](docs/contract.md): scope, invariants, SDK compatibility findings and open questions about the extension

## Official references

- [MCP Tasks extension overview](https://tasks.extensions.modelcontextprotocol.io/)
- [Tasks extension specification, revision 2026-07-28](https://tasks.extensions.modelcontextprotocol.io/specification/2026-07-28/tasks.html)
- [SEP-2663 proposal](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2663-tasks-extension.md)
- [Official schema for revision 2026-07-28](https://github.com/modelcontextprotocol/ext-tasks/blob/main/schema/2026-07-28/schema.json)
- [`@modelcontextprotocol/ext-tasks`](https://www.npmjs.com/package/@modelcontextprotocol/ext-tasks), the official client-side package
- [TypeScript SDK v2 migration notes for protocol revision 2026-07-28](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28)

## What survives what

`WalTaskStore` writes every change to a write-ahead log before it returns, and replays the log when it opens. When `createTask()` returns, the task is already on disk. The extension requires this; it is the main guarantee of this package.

| Mode                     | Process crash, `SIGKILL`, restart | Host or power loss             |
| ------------------------ | --------------------------------- | ------------------------------ |
| `fsync: false` (default) | Recoverable                       | Not guaranteed                 |
| `fsync: true`            | Recoverable                       | Requests a storage flush first |

The left column is tested. `test/crash.test.ts` starts real child processes, kills them with `SIGKILL` at a known state and reopens the directory. The tests load `dist/`, so they check the package you install:

- A task created and never touched again comes back as `working`.
- A task waiting for input comes back with its requests and used keys. A restarted process cannot reuse a key the dead one issued.
- A client reply that arrived while no worker was running is kept, across further kills, until a restarted worker claims it with `resumeInput()`.
- A completed task keeps its result, and an acknowledged progress version is never lost.
- A confirmed snapshot of several tasks survives a kill during compaction.

The worker's suspended `requestInput()` call does not survive a restart, but the answers do. A restarted worker calls `task.resumeInput()` first. It returns the responses that arrived while no worker was waiting, at most once, or `undefined`. If the client has not answered yet, the worker can call it again later, or ask again with new keys; the old keys stay spent ([durability](docs/durability.md#what-durability-does-not-cover)).

A fast-check model also runs random schedules of progress, TTL changes, clock rollbacks, input responses, cancellation and CAS conflicts against an independent reference.

### Compaction

Compaction runs automatically after the change that triggered it is saved. If it fails, that change is still committed. Pass `onCompactionError` to be notified; the event says whether the log is still usable. If not, the next store operation fails with `ERR_WAL_UNUSABLE`, and you close and reopen the store.

### Size limit

`WalTaskStore` sets `maxEntryBytes` to **8 MiB per encoded task record** by default, envelope and metadata included (about 100,000 build-log lines of 80 bytes). You can change it. A change over the limit is not committed and throws `TaskEntryTooLargeError` (`code` `ERR_ENTRY_TOO_LARGE`), so a worker can keep its finished work by retrying the final step with a summary or a truncated result:

```ts
import { isTaskEntryTooLargeError } from "mcp-durable-tasks";

try {
  await task.complete(fullResult);
} catch (error) {
  if (!isTaskEntryTooLargeError(error)) throw error;
  await task.complete({ truncated: true, summary: summarize(fullResult) });
}
```

A higher limit only moves the point where this error happens. Use the predicate instead of `instanceof`: if npm installs the package twice, or you load both the CJS and ESM builds, the copies do not share an error class.

### Validation

Results, errors and input payloads must be plain JSON. Both stores check this before changing any state, so memory always matches what the log replays. They reject `Map`, `Date`, `bigint`, functions, cycles, array holes and non-finite numbers (`-0` is stored as `0`). Input requests and responses are also checked against the `2026-07-28` schema ([contract](docs/contract.md#input-rounds)).

`fail()` takes a JSON-RPC error object: an integer `code`, a string `message` and optional `data`. Anything else throws `TypeError` and nothing is written ([contract](docs/contract.md#wire-contract)).

## See it survive a crash

`examples/crash-recovery/` is a real MCP server whose task outlives its process. One command starts the server, defers work through `tools/call`, kills the server with `SIGKILL`, starts it again and reads the finished result from the new process:

```sh
pnpm --filter mcp-durable-tasks-example-crash-recovery run demo
```

[![Watch the crash-recovery demo](https://asciinema.org/a/U0DD3KWEttwhv5g5.svg)](https://asciinema.org/a/U0DD3KWEttwhv5g5)

The key output, as text:

```
3. Kill the server outright — SIGKILL, no shutdown hook, no flush
   process gone. Whatever is on disk is all there is.

5. Ask the new process for the task the dead one finished
   tasks/get → completed
   result   → {"content":[{"type":"text","text":"indexed 5 files, 0 errors"}], ...}
```

The demo runs on every pull request. It also shows how to serve `tasks/*` through the official SDK, which the next section explains.

## The official SDK's era gate

Since `@modelcontextprotocol/server` 2.3.0 ([typescript-sdk#2599](https://github.com/modelcontextprotocol/typescript-sdk/pull/2599)), handlers registered with an explicit schema (`setRequestHandler(method, schemas, handler)`) serve `tasks/get`, `tasks/update` and `tasks/cancel`. Typed registration and `fallbackRequestHandler` still return `-32601` for get and cancel (measured on 2.3.1). The crash-recovery example uses explicit-schema handlers. Two details are easy to miss:

- The SDK answers `-32020` before any handler runs when the `Mcp-Name` header does not match `params.taskId`.
- On a `2026-07-28` request, `params.inputResponses` arrives as `ctx.mcpReq.inputResponses`. A `tasks/update` handler must read it there.

Before 2.3.0, the SDK answers `-32601` to get and cancel before any handler runs, because both names belong to the retired `2025-11-25` registry. You need a narrow workaround; the [compatibility profile](docs/contract.md#typescript-sdk-v2-compatibility) lists the two we verified.

## Writing your own store

`TaskStore` has five methods. The conformance kit ships with the package so you can check your implementation:

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

The kit has no dependencies and works with any test runner: pass its `describe` and `it`. Without a runner, `checkTaskStore(name, factory)` runs the same checks and returns a report.

The factory runs once per check and must return a new store each time. Two optional parts:

- `advanceTime(ms)`, if your store has a clock you can control. Also add `now()`, which returns that clock's time, unless the clock starts at `2026-01-01T00:00:00Z`.
- `reopen()`, if a new instance can reconnect to the same stored data.

Without them, the TTL or cross-instance durability checks are reported as skipped, never as passed. Recording a real skip needs `runner.skip(context, reason)`; without it, a missing optional part fails with a clear message. The reopen checks run a full partial-input round and check that `usedInputKeys` and `unclaimedInputResponses` are stored and replayed like every other field, so a store that keeps a fixed list of fields fails.

Every factory call, check, `close()` and `dispose()` has a 10-second limit by default (`timeoutMs`). A failure during cleanup counts as a failed check.

`TaskPatch` follows object spread rules: only enumerable own string-keyed properties count, and `undefined` deletes the field. The kit tests both.

If you publish a store, open an issue and we can link it from these docs.

## Development

Needs Node.js 22.13 or newer. The repository pins pnpm 11.

```sh
git clone https://github.com/AndresSaa/mcp-durable-tasks.git
cd mcp-durable-tasks
corepack pnpm install --frozen-lockfile
corepack pnpm lint
corepack pnpm test
corepack pnpm coverage
corepack pnpm lint:package   # packs, installs and imports the real tarball
corepack pnpm check:schema   # compares the vendored schema against upstream
```

## License

MIT
