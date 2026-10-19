# ![mcp-durable-tasks — durable, resumable task state for MCP servers](https://raw.githubusercontent.com/AndresSaa/mcp-durable-tasks/main/.github/assets/readme-banner.webp)

[![CI](https://github.com/AndresSaa/mcp-durable-tasks/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/AndresSaa/mcp-durable-tasks/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/mcp-durable-tasks?logo=npm&color=cb3837)](https://www.npmjs.com/package/mcp-durable-tasks)
[![MCP Tasks](https://img.shields.io/badge/MCP_Tasks-SEP--2663-7c3aed)](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2663-tasks-extension.md)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933?logo=nodedotjs&logoColor=white)](https://github.com/AndresSaa/mcp-durable-tasks/blob/main/package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/AndresSaa/mcp-durable-tasks/blob/main/LICENSE)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/AndresSaa/mcp-durable-tasks/badge)](https://scorecard.dev/viewer/?uri=github.com/AndresSaa/mcp-durable-tasks)

**A library you import into an MCP server to keep its long-running tasks durable across restarts.** It implements the server side of the MCP Tasks extension (`io.modelcontextprotocol/tasks`, SEP-2663). It is not a server you add to `mcp.json`, and it is not a to-do manager.

When a tool call takes minutes, the extension lets the server return a task handle instead of making the client wait. The client then polls `tasks/get` for the result. If the server restarts halfway, a handle kept in memory is gone, and the client polls a task that no longer exists. With `WalTaskStore`, the task is on disk before `createTask()` returns, so `tasks/get` still answers after a crash or a redeploy.

You get the task state machine, TTL, polling hints and the input-request round trip (`tasks/update`). The main entry point has no runtime dependencies. Transport, auth and the client are not included; for the client, use the official [`@modelcontextprotocol/ext-tasks`](https://www.npmjs.com/package/@modelcontextprotocol/ext-tasks) package. This library targets the stable `2026-07-28` revision.

## Quick start

```ts
import { TaskLifecycle } from "mcp-durable-tasks";
import { WalTaskStore } from "mcp-durable-tasks/wal";

const tasks = new TaskLifecycle({ store: new WalTaskStore({ dir: "./data" }) });

// In tools/call: return a task instead of a result.
const created = await tasks.createTask({ ttlMs: 3_600_000 });
runTheWork(tasks.handle(created.taskId)); // not awaited

// In tasks/get, also after a restart:
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

If tasks do not need to outlive the process (in tests, for example), use `MemoryTaskStore` from the main entry point instead.

## Install

```sh
pnpm add mcp-durable-tasks process-wal
```

Needs Node.js 22 or newer. `process-wal` is an optional peer dependency, and only the `/wal` entry point uses it. If you only want `MemoryTaskStore`, skip it.

| Entry point                 | What it contains                     | Needs         |
| --------------------------- | ------------------------------------ | ------------- |
| `mcp-durable-tasks`         | the engine, `MemoryTaskStore`, types | nothing       |
| `mcp-durable-tasks/wal`     | `WalTaskStore`                       | `process-wal` |
| `mcp-durable-tasks/testing` | the store conformance kit            | nothing       |

The main entry point uses no Node built-ins, so the engine and `MemoryTaskStore` also run in web-standard runtimes.

## Two limits to know first

**`WalTaskStore` is for one process and one disk.** It uses [`process-wal`](https://github.com/AndresSaa/process-wal), which has a single writer. If two processes open the same directory, the log gets corrupted. That fits MCP servers over stdio (Claude Code, Cursor, VS Code), where long tasks such as builds and test suites are common. If your server is stateless behind a load balancer, implement `TaskStore` on your shared database. It has five methods, and the [conformance kit](#writing-your-own-store) tests your implementation.

**A running worker stays in one process.** The saved record is safe when several instances write it, but the promise that `requestInput()` returns and the cancellation signal live in the process that runs the worker. While it runs, `tasks/update` and `tasks/cancel` must reach that same instance. Over Streamable HTTP, the client sends the task ID in an `Mcp-Name` header, so your load balancer can route on it. That routing is your job: this library does not read headers and has no queue. See [process boundaries](docs/contract.md#process-boundaries).

## What survives a crash

`WalTaskStore` appends every change to a write-ahead log before the call returns, and replays the log when it opens.

| Mode                     | Process crash, `SIGKILL`, restart | Host or power loss             |
| ------------------------ | --------------------------------- | ------------------------------ |
| `fsync: false` (default) | Recoverable                       | Not guaranteed                 |
| `fsync: true`            | Recoverable                       | Requests a storage flush first |

The left column is tested. `test/crash.test.ts` starts real child processes, kills them with `SIGKILL` and reopens the directory. [Durability](docs/durability.md) lists every scenario.

A worker's suspended `requestInput()` call does not survive a restart, but the answers do. A restarted worker calls `task.resumeInput()` first, which returns the replies that arrived while no worker was waiting (at most once).

Two things can surprise you:

- A task record is capped at 8 MiB by default (`maxEntryBytes`). A change over the cap throws `TaskEntryTooLargeError` and saves nothing, so complete the task with a summary instead of the full output ([size limits](docs/durability.md#size-limits)).
- Results, errors and input payloads must be plain JSON. The stores reject `Map`, `Date`, `bigint`, cycles and similar values before changing anything.

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

The demo runs on every pull request. It also shows how to serve `tasks/*` through the official SDK.

## Using it with the official SDK

Since `@modelcontextprotocol/server` 2.3.0 ([typescript-sdk#2599](https://github.com/modelcontextprotocol/typescript-sdk/pull/2599)), register `tasks/get`, `tasks/update` and `tasks/cancel` with an explicit schema: `setRequestHandler(method, schemas, handler)`. Typed registration and `fallbackRequestHandler` still answer `-32601` for get and cancel (measured on 2.3.1). Two details are easy to miss:

- The SDK answers `-32020` before any handler runs when the `Mcp-Name` header does not match `params.taskId`.
- On a `2026-07-28` request, `params.inputResponses` arrives as `ctx.mcpReq.inputResponses`. A `tasks/update` handler must read it there.

Before 2.3.0, the SDK answers `-32601` to get and cancel before any handler runs, because both names belong to the retired `2025-11-25` registry. You need a narrow workaround; the [compatibility profile](docs/contract.md#typescript-sdk-v2-compatibility) lists the two we verified.

## Writing your own store

`TaskStore` has five methods. The conformance kit ships with the package, so you can test your implementation:

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

The kit works with any test runner. The factory runs once per check and must return a new store each time. Two parts are optional: `advanceTime(ms)` if your store has a clock you can control, and `reopen()` if a new instance can reconnect to the same data. Checks that need a missing part are reported as skipped, never as passed. The [API reference](docs/api.md#mcp-durable-taskstesting) has the rest.

If you publish a store, open an issue and we can link it from these docs.

## Documentation

- [**API**](docs/api.md): every option, method and error
- [Durability](docs/durability.md): what survives what, and the two unsupported configurations
- [Internals](docs/internals.md): design decisions and source layout
- [Contract and conformance](docs/contract.md): scope, invariants, SDK compatibility findings and open questions about the extension
- [Changelog](CHANGELOG.md)

## Status

The current release is `v0.4.0`. Before `1.0.0`, breaking changes ship as minor releases and the public API may still change; the changelog lists them. The roadmap is in the [contract](docs/contract.md).

Not built yet: a change emitter for the optional `notifications/tasks` message (the engine emits each committed change, the host delivers it). There is no client entry point and none is planned; use `@modelcontextprotocol/ext-tasks/client`.

## Official references

- [MCP Tasks extension overview](https://tasks.extensions.modelcontextprotocol.io/)
- [Tasks extension specification, revision 2026-07-28](https://tasks.extensions.modelcontextprotocol.io/specification/2026-07-28/tasks.html)
- [SEP-2663 proposal](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2663-tasks-extension.md)
- [Official schema for revision 2026-07-28](https://github.com/modelcontextprotocol/ext-tasks/blob/main/schema/2026-07-28/schema.json)
- [`@modelcontextprotocol/ext-tasks`](https://www.npmjs.com/package/@modelcontextprotocol/ext-tasks), the official client-side package
- [TypeScript SDK v2 migration notes for protocol revision 2026-07-28](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28)

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
