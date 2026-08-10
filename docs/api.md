# API

The complete surface: three entry points, two stores, one engine, and the
errors. The [README](../README.md) carries the shape of the thing; this carries
the contract.

The public API is **provisional until `1.0.0`**. Breaking changes before then
are minor bumps with a changelog entry — see the
[version contract](contract.md#version-contract).

```ts
import {
  TaskLifecycle,
  MemoryTaskStore,
  TaskNotFoundError,
} from "mcp-durable-tasks";
import { WalTaskStore } from "mcp-durable-tasks/wal";
import { runTaskStoreConformance } from "mcp-durable-tasks/testing";
```

| Entry point                 | Contents                         | Requires      |
| --------------------------- | -------------------------------- | ------------- |
| `mcp-durable-tasks`         | engine, `MemoryTaskStore`, types | nothing       |
| `mcp-durable-tasks/wal`     | `WalTaskStore`                   | `process-wal` |
| `mcp-durable-tasks/testing` | the store conformance kit        | nothing       |

The main entry point imports no Node built-ins, so the engine and
`MemoryTaskStore` run in Workers, Deno and Bun as well as Node.

---

## `TaskLifecycle`

The state machine. One instance owns the tasks created through it.

```ts
const tasks = new TaskLifecycle({ store: new MemoryTaskStore() });
```

### Options

| Option                  | Type             | Default             | Meaning                                                                                                       |
| ----------------------- | ---------------- | ------------------- | ------------------------------------------------------------------------------------------------------------- |
| `store`                 | `TaskStore`      | —                   | Required. Where task state lives.                                                                             |
| `defaultTtlMs`          | `number \| null` | `3_600_000`         | TTL for new tasks. `null` is unlimited. Must be `null` or `> 0`.                                              |
| `defaultPollIntervalMs` | `number \| null` | `1_000`             | The polling hint sent to clients. `null` omits it.                                                            |
| `sweepIntervalMs`       | `number \| null` | `null`              | Automatic sweep period. The timer is `unref`'d.                                                               |
| `now`                   | `() => number`   | `Date.now`          | Injectable clock. For tests; nothing else should pass it.                                                     |
| `generateTaskId`        | `() => string`   | `crypto.randomUUID` | Must stay unguessable — see [Security](https://github.com/AndresSaa/mcp-durable-tasks/blob/main/SECURITY.md). |

### Methods

| Method                               | Serves         | Contract                                                      |
| ------------------------------------ | -------------- | ------------------------------------------------------------- |
| `createTask(init?)`                  | `tools/call`   | Creates the task and resolves only once it is durable         |
| `handle(taskId)`                     | —              | The write side, for the worker                                |
| `getTask(taskId)`                    | `tasks/get`    | Pure read. Never mutates anything                             |
| `updateTask(taskId, inputResponses)` | `tasks/update` | Applies outstanding input responses. Complete acknowledgement |
| `cancelTask(taskId)`                 | `tasks/cancel` | Raises the worker's signal. Complete acknowledgement          |
| `close()`                            | —              | Stops the sweeper, wakes parked workers, closes the store     |

#### `createTask(init?)`

```ts
const created = await tasks.createTask({
  ttlMs: 3_600_000, // null | > 0
  pollIntervalMs: 2_000,
  statusMessage: "queued",
});
```

Returns a `CreateTaskResult`: the flat base task with `resultType: "task"`.
**It does not resolve until the store says the
record is durable**, which is what the extension requires normatively — a
server MUST NOT return a `CreateTaskResult` before a `tasks/get` for that id
would resolve.

`ttlMs: 0` throws `TypeError`. Zero would acknowledge a task that expires the
instant it is created, which is a task no client can ever read.

#### `getTask(taskId)`

Returns the `DetailedTask` variant for the current status. Throws
`TaskNotFoundError` when the task does not exist **or its TTL has elapsed** —
the two are deliberately indistinguishable.

Every returned variant includes `resultType: "complete"`, as required for a
completed protocol request. Internal store fields such as `version` are never
projected onto this closed wire shape.

This method writes nothing. Not `lastUpdatedAt`, not a cache, and it triggers
no sweep. Reads and writes are separated in the extension so reads stay
idempotent and cacheable.

#### `updateTask(taskId, inputResponses)`

```ts
await tasks.updateTask(taskId, {
  "the-key": { roots: [] },
});
```

Applies responses whose keys are currently outstanding, and **ignores every
other key** — never issued, already answered, or superseded. That is what the
extension asks for, so a mixed update applies the good keys and drops the rest
without complaining.

Three consequences worth knowing:

- **Partial answers are legal.** The task stays `input_required` until every
  outstanding key has an answer.
- **A repeated answer is a no-op**, not an overwrite.
- **An update to a task that has already finished is an empty acknowledgement,
  not an error.** No key is outstanding on a terminal task, so every key in
  such an update is one the server should ignore. A client racing a late
  response against a task that just completed is behaving correctly.

Responses are validated against the request they answer. A response that does
not match the shape of its `sampling/createMessage`, `roots/list` or
`elicitation/create` request throws `TypeError` and nothing is committed.

`TaskNotFoundError` still applies to an unknown id.

The acknowledgement is `{ resultType: "complete" }`.

#### `cancelTask(taskId)`

Raises the worker's `AbortSignal` with a `TaskCancelled` reason and **changes
no status**. Cancellation is cooperative and eventually consistent: the task
may stay `working` after the acknowledgement, and may end at a terminal status
other than `cancelled` if the work finished first.

A worker that honours the signal calls `handle.cancelled()`. One that ignores
it leaves the task to its TTL. Cancelling an already-terminal task is a no-op.
The acknowledgement is `{ resultType: "complete" }` in both cases.

#### `close()`

Idempotent. Rejects every parked `requestInput()` promise rather than leaving
workers suspended, then closes the store.

---

## `TaskHandle`

What a worker writes through. Obtained with `tasks.handle(taskId)`.

```ts
async function work(task: TaskHandle) {
  await task.progress("indexing", { pollIntervalMs: 2_000 });

  const answers = await task.requestInput({
    "roots-1": { method: "roots/list" },
  });

  if (task.signal.aborted) return task.cancelled("client asked to stop");
  await task.complete({ content: [{ type: "text", text: "done" }] });
}
```

| Member                            | Contract                                                                 |
| --------------------------------- | ------------------------------------------------------------------------ |
| `taskId`                          | The id this handle writes to                                             |
| `signal`                          | `AbortSignal`, raised by `tasks/cancel`. Cooperative — nothing is killed |
| `progress(statusMessage, patch?)` | Sets `statusMessage`, optionally revises `pollIntervalMs` / `ttlMs`      |
| `requestInput(requests)`          | Parks in `input_required`; resolves when every key is answered           |
| `complete(result)`                | Terminal. `result` must be a JSON object                                 |
| `fail(error)`                     | Terminal. `error` must be a JSON object                                  |
| `cancelled(statusMessage?)`       | Terminal. Acknowledges a cancellation the worker chose to honour         |

Result, error, request and response trees are detached and validated before a
write. `-0` is accepted because it is a valid JSON number, then canonicalised
to `0` before either store can observe it. Non-finite numbers and non-JSON
objects are rejected without changing the task.

Any write to a task that is already `completed`, `failed` or `cancelled`
throws `TaskAlreadyTerminalError`. That is the library's own bug class, not the
caller's: it means a worker kept writing after it finished, or two code paths
owned the same task. It throws rather than being ignored, because a silently
swallowed double-complete is the defect this package exists to prevent.

### `requestInput(requests)`

The sharpest part of the surface.

```ts
const answers = await task.requestInput({
  "sample-1": {
    method: "sampling/createMessage",
    params: { messages: [], maxTokens: 512 },
  },
});
```

- **Requests are typed**, not a free-form channel: each must be a
  `sampling/createMessage`, `roots/list` or `elicitation/create` request, with
  the fields that request actually requires. Anything else throws `TypeError`
  before the task moves.
- **Validation follows the SDK source at version 1.30.0**, including integer
  `maxTokens`, Base64 binary blocks, object-rooted tool schemas,
  `execution.taskSupport`, `file://` roots, and URL elicitation's required
  `elicitationId` plus URL-valid `url`. The generated extension JSON Schema
  loses this imported union and is not used as the authority.
- **Keys are unique for the whole lifetime of the task**, including after it is
  terminal and across a restart. Reusing one throws `DuplicateInputKeyError`.
- **The promise settles exactly once**: it resolves when every key is answered,
  and rejects if the task is cancelled, finishes some other way, expires, or
  the engine closes. It never leaks.

**There is no way to observe the moment the task becomes parked**, and that is
deliberate. A client learns which keys exist by polling `tasks/get`, so that is
the only observable point that matters. In a test, poll `getTask` until the
status is `input_required` rather than assuming the write has landed.

### Worker process affinity

The durable record lives in the `TaskStore`, but the promise `requestInput()`
returns and the `AbortSignal` belong to **the process running the worker**.
While a worker is live, `tasks/update` and `tasks/cancel` have to reach that
instance — sticky routing, or coordination you provide.

This is not an oversight and it is not a limitation the specification resolves
either; see [process boundaries](contract.md#process-boundaries). Embedding a
broker would turn this state engine into the queue explicitly excluded by the
[non-goals](contract.md#non-goals). After a crash there is no promise left to
wake — there is durable state, which is the point.

---

## `TaskStore`

Five methods. This is what you implement to put tasks somewhere else.

```ts
interface TaskStore {
  create(record: TaskRecord): Promise<void>;
  get(taskId: string): Promise<TaskRecord | undefined>;
  update(
    taskId: string,
    patch: TaskPatch,
    expectedVersion: number,
  ): Promise<TaskRecord>;
  sweep(now?: number): Promise<number>;
  close(): Promise<void>;
}
```

| Method   | Must                                                                                    |
| -------- | --------------------------------------------------------------------------------------- |
| `create` | Not resolve until a later `get()` would find the record. This is the durability promise |
| `get`    | Return `undefined` for an unknown id **and** for one whose TTL elapsed                  |
| `update` | Reject with `ConcurrentUpdateError` when the stored version is not `expectedVersion`    |
| `sweep`  | Return a count. **Never** the records — the extension has no enumeration, by design     |
| `close`  | Be idempotent                                                                           |

Four rules that are easy to get wrong, and that the conformance kit checks:

1. **`undefined` in a patch deletes the field.** It does not mean "leave
   unchanged". A task leaving `input_required` clears its requests this way,
   and a leftover map would be emitted onto a wire shape that forbids extra
   properties. The rule covers **enumerable own string-keyed** properties.
2. **Every successful `update` bumps `version` by exactly one.**
3. **Hand out copies, not references.** A caller who mutates a returned
   `result` in place must not change stored state — that would be a write with
   no version bump and nothing logged.
4. **TTL is measured from `createdAt` plus the current `ttlMs`**, which may
   change during the task's life. Raising it extends the same window rather
   than restarting the clock; setting it to `null` makes the task unlimited
   from then on.

`TaskRecord` carries three fields that are **internal and must never reach the
wire**: `version`, `inputResponses` and `usedInputKeys`. The engine's
projection is allow-list based so they cannot leak, but a store must persist
them faithfully — `usedInputKeys` in particular has to survive both the
terminal transition and a replay, or key uniqueness breaks after a restart.

---

## `MemoryTaskStore`

```ts
new MemoryTaskStore({ now: () => Date.now() });
```

In-process. Tests, development, and servers whose tasks need not outlive the
process. Uses no Node built-ins — this is the store that proves the engine runs
on web-standard runtimes.

It satisfies the durability promise vacuously: its boundary _is_ the process.
That is the honest statement of what in-memory storage gives you, and it is why
the crash tests run against `WalTaskStore`.

---

## `WalTaskStore`

```ts
import { WalTaskStore, DEFAULT_MAX_ENTRY_BYTES } from "mcp-durable-tasks/wal";

const store = new WalTaskStore({ dir: "./data" });
```

Durable across process restarts, on top of
[`process-wal`](https://github.com/AndresSaa/process-wal). An in-memory index
serves reads; every mutation is appended to a write-ahead log first, and the
log replays into the index on open.

| Option              | Type              | Default    | Meaning                                                         |
| ------------------- | ----------------- | ---------- | --------------------------------------------------------------- |
| `dir`               | `string`          | —          | Required. Holds `wal.jsonl` and `wal.checkpoint`                |
| `fsync`             | `boolean`         | `false`    | `true` moves the boundary from the page cache to storage        |
| `maxEntryBytes`     | `number`          | 8 MiB      | Largest encoded task record the log accepts                     |
| `compactEvery`      | `number \| null`  | `1_000`    | Superseded entries before an automatic rewrite. `null` disables |
| `now`               | `() => number`    | `Date.now` | Injectable clock, for TTL                                       |
| `onCompactionError` | `(event) => void` | —          | Observes a failed automatic compaction                          |

**One process, one directory.** `process-wal` is single-writer and does not
lock; two processes on the same directory corrupt the log. See
[durability.md](durability.md).

### `compact()`

Rewrites the log as a snapshot of live tasks and drops everything before it.
Called automatically according to `compactEvery`; public because it is policy,
not housekeeping — a long-lived process may want to control when it happens.

An automatic compaction that fails **does not fail the mutation that triggered
it**: that write was already durable before compaction began, and reporting it
as failed would be a lie. The failure is reported through `onCompactionError`
and, if it left the underlying log unusable, surfaced on the next operation.

---

## Errors

| Class                      | When                                                         | What to do                           |
| -------------------------- | ------------------------------------------------------------ | ------------------------------------ |
| `TaskNotFoundError`        | No such task, or its TTL elapsed                             | Answer the client `-32602`           |
| `TaskAlreadyTerminalError` | A write to a task that already finished                      | Fix the caller — this is a bug       |
| `ConcurrentUpdateError`    | Compare-and-swap lost                                        | Retry; the engine already does       |
| `DuplicateInputKeyError`   | An input key was reused within one task's lifetime           | Fix the caller — this is a bug       |
| `TaskEntryTooLargeError`   | A record exceeded `maxEntryBytes`. Nothing was committed     | Complete again with a smaller result |
| `TaskCancelled`            | The reason on an aborted `signal`, not thrown by the library | Stop the work                        |

`TaskEntryTooLargeError` carries a stable `code` of `ERR_ENTRY_TOO_LARGE`, so a
worker can recover rather than lose the work it just finished:

```ts
import { isTaskEntryTooLargeError } from "mcp-durable-tasks";

try {
  await task.complete(hugeResult);
} catch (error) {
  if (!isTaskEntryTooLargeError(error)) throw error;
  await task.complete({ truncated: true, summary: summarise(hugeResult) });
}
```

`isTaskEntryTooLargeError()` checks the stable code, and
`isConcurrentUpdateError()` checks the stable CAS name. Use these predicates
at package boundaries: duplicated installations and separate CJS bundles do
not guarantee that an error shares the consumer's class identity.

There is deliberately **no error for an unrecognised input key**: the
extension says a server SHOULD ignore responses whose key is not outstanding,
so throwing would be a conformance bug.

---

## `mcp-durable-tasks/testing`

The conformance kit. See [README](../README.md#writing-your-own-store) for the
short version.

| Export                                             | Purpose                                        |
| -------------------------------------------------- | ---------------------------------------------- |
| `runTaskStoreConformance(name, factory, options?)` | Declares the suite in your test runner         |
| `checkTaskStore(name, factory, checks?, options?)` | Runs the checks and returns a report           |
| `conformanceChecks`                                | The check list, if you want to filter it       |
| `conformanceRecord(overrides?)`                    | Builds a valid `TaskRecord` for your own tests |

The factory is called **once per check** and must return a fresh, isolated
store each time. Sharing one leaks state between checks, and a suite whose
result depends on ordering is worse than none — so the kit detects a reused
instance and fails.

```ts
runTaskStoreConformance(
  "RedisTaskStore",
  () => ({
    store: new RedisTaskStore({ url }),
    advanceTime: (ms) => clock.advance(ms), // optional
    reopen: () => new RedisTaskStore({ url }), // optional
    dispose: () => cleanup(), // optional
  }),
  { runner: { describe, it, skip } },
);
```

`advanceTime` and `reopen` are optional seams. Without them the checks that
need them are **skipped, not passed** — a store that cannot fake time or
reconnect gets an honest report rather than credit for checks that never ran.

---

## See also

- [durability.md](durability.md) — what survives what, and why
- [internals.md](internals.md) — how it is put together
- [contract.md](contract.md) — scope, invariants and open conformance questions
- [SECURITY.md](https://github.com/AndresSaa/mcp-durable-tasks/blob/main/SECURITY.md) — the threat model
