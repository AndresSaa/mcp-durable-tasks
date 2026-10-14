# API

Every public signature and what it does. The API is **provisional until `1.0.0`**: a breaking change before then is a minor bump with a changelog entry ([version contract](contract.md#version-contract)).

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

The main entry point imports no Node built-ins, so the engine and `MemoryTaskStore` also run in Workers, Deno and Bun.

---

## `TaskLifecycle`

The state machine. One instance owns the tasks created through it.

```ts
const tasks = new TaskLifecycle({ store: new MemoryTaskStore() });
```

### Options

| Option                  | Type             | Default             | Meaning                                                                                                         |
| ----------------------- | ---------------- | ------------------- | --------------------------------------------------------------------------------------------------------------- |
| `store`                 | `TaskStore`      | —                   | Required. Where task state lives.                                                                               |
| `defaultTtlMs`          | `number \| null` | `3_600_000`         | TTL for new tasks. `null` is unlimited. Must be `null` or a safe integer `> 0`.                                 |
| `defaultPollIntervalMs` | `number \| null` | `1_000`             | The polling hint sent to clients. `null` omits it. Must be a safe integer.                                      |
| `sweepIntervalMs`       | `number \| null` | `null`              | Automatic sweep period. `null` disables it. Must be an integer from 1 to 2,147,483,647. The timer is `unref`'d. |
| `now`                   | `() => number`   | `Date.now`          | Injectable clock, for tests only.                                                                               |
| `generateTaskId`        | `() => string`   | `crypto.randomUUID` | Must stay unguessable — see [Security](https://github.com/AndresSaa/mcp-durable-tasks/blob/main/SECURITY.md).   |

An invalid option throws `TypeError` from the constructor, before any timer starts. (Node would run an out-of-range timer delay as a 1 ms loop.)

### Methods

| Method                               | Serves         | Returns            | Contract                                                  |
| ------------------------------------ | -------------- | ------------------ | --------------------------------------------------------- |
| `createTask(init?)`                  | `tools/call`   | `CreateTaskResult` | Creates the task; resolves only once it is durable        |
| `handle(taskId)`                     | —              | `TaskHandle`       | The write side, for the worker                            |
| `getTask(taskId)`                    | `tasks/get`    | `GetTaskResult`    | Pure read. Never mutates anything                         |
| `updateTask(taskId, inputResponses)` | `tasks/update` | `UpdateTaskResult` | Applies outstanding input responses                       |
| `cancelTask(taskId)`                 | `tasks/cancel` | `CancelTaskResult` | Raises the worker's signal                                |
| `close()`                            | —              | `Promise<void>`    | Stops the sweeper, wakes parked workers, closes the store |

#### `createTask(init?)`

```ts
const created = await tasks.createTask({
  ttlMs: 3_600_000, // null | > 0
  pollIntervalMs: 2_000,
  statusMessage: "queued",
});
```

Returns the flat base task with `resultType: "task"`. **It does not resolve until the store says the record is durable** ([durability](durability.md#the-promise)).

Input rules, which also apply wherever the same field appears (`progress()`, `cancelled()`, the constructor defaults). A violation throws `TypeError` before anything is stored:

- `ttlMs` and `pollIntervalMs` are whole milliseconds in the safe-integer range, as the stable schema types them. No fractions, `NaN`, `Infinity` or non-numbers.
- `ttlMs` is `null` or greater than 0; `ttlMs: 0` would create a task no client can read. `pollIntervalMs: 0` is fine.
- `statusMessage` is a string, checked at runtime too for JavaScript callers.
- A record written before these checks, with a non-integer hint, still opens and is served as stored until the worker revises it ([contract](contract.md#wire-contract)).

#### `getTask(taskId)`

Returns the `DetailedTask` variant for the current status, with `resultType: "complete"` and no internal store fields. Throws `TaskNotFoundError` when the task does not exist **or its TTL has elapsed**; the two are deliberately indistinguishable. It writes nothing: not `lastUpdatedAt`, not a cache, and it triggers no sweep (I3).

#### `updateTask(taskId, inputResponses)`

```ts
await tasks.updateTask(taskId, {
  "the-key": { roots: [] },
});
```

Applies responses whose keys are outstanding and **ignores every other key** (never issued, already answered, or superseded), as the extension asks. Returns `{ resultType: "complete" }`.

- **Partial answers are legal.** The task stays `input_required` until every outstanding key has an answer.
- **A repeated answer is a no-op**, not an overwrite.
- **An update to a finished task is an empty acknowledgement**, not an error: no key is outstanding any more.
- A response that does not match the shape of its `sampling/createMessage`, `roots/list` or `elicitation/create` request throws `TypeError`, and nothing is committed.
- An unknown id throws `TaskNotFoundError`.

#### `cancelTask(taskId)`

Raises the worker's `AbortSignal` with a `TaskCancelled` reason and **changes no status**. Returns `{ resultType: "complete" }`, also for an already-terminal task, where it is a no-op.

Cancellation is cooperative and eventually consistent: the task may stay `working` for a while, or end at another terminal status if the work finished first. A worker that honours the signal calls `handle.cancelled()`; one that ignores it leaves the task to its TTL.

The raised signal is process-local. A worker here that reads `handle.signal` later still finds it raised, until the task ends through this lifecycle, expires by its clock, or `close()` runs ([contract](contract.md#process-boundaries)).

#### `close()`

Idempotent. Rejects every parked `requestInput()` promise instead of leaving workers suspended, then closes the store.

---

## `TaskHandle`

What a worker writes through. Get one with `tasks.handle(taskId)`.

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

| Member                            | Signature                                                     | Contract                                                                                  |
| --------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `taskId`                          | `string`                                                      | The id this handle writes to                                                              |
| `signal`                          | `AbortSignal`                                                 | Raised by `tasks/cancel` or TTL expiry. Cooperative: nothing is killed                    |
| `progress(statusMessage, patch?)` | `patch?: { pollIntervalMs?: number; ttlMs?: number \| null }` | Sets `statusMessage`; optionally revises the hints. Invalid input: whole call not applied |
| `requestInput(requests)`          | `→ Promise<InputResponses>`                                   | Parks in `input_required`; resolves when every key is answered                            |
| `resumeInput()`                   | `→ Promise<InputResponses \| undefined>`                      | Claims answers that arrived while no worker waited, exactly once                          |
| `complete(result)`                | `result: JsonObject`                                          | Terminal                                                                                  |
| `fail(error)`                     | `error: TaskError`                                            | Terminal. A JSON-RPC error: integer `code`, string `message`                              |
| `cancelled(statusMessage?)`       | `statusMessage?: string`                                      | Terminal. Acknowledges a cancellation the worker chose to honour                          |

Every write method returns `Promise<void>` unless shown otherwise.

**`signal.reason`** is a `TaskCancelled` after `tasks/cancel`, or a `TaskNotFoundError` once the TTL elapses by the lifecycle's clock (`ttlMs: null` never aborts). A signal raised by a cancellation keeps its first reason. Tell them apart with `signal.reason.name`. A worker that only reads `signal` and never writes is told too. Expiry abort is an engine policy that writes nothing ([contract](contract.md#process-boundaries)).

**`fail(error)`** takes `TaskError`, `{ code: number; message: string; data?: JsonValue }`, as the stable schema requires. A missing or non-integer `code`, or a missing or non-string `message`, throws `TypeError` and writes nothing. Extra JSON members are kept (the schema is open). `TaskRecord.error` and `FailedTask.error` stay `JsonObject`, so an older log with some other `error` still opens and serves it unchanged ([contract](contract.md#wire-contract)).

**Payloads.** Result, error, request and response trees are copied and validated before a write. Non-finite numbers and non-JSON objects are rejected without changing the task. `-0` is accepted and stored as `0`.

**Writes after the end** throw `TaskAlreadyTerminalError`: a worker kept writing after it finished, or two code paths own one task. A silently swallowed double-complete is the defect this package exists to prevent.

### `requestInput(requests)`

```ts
const answers = await task.requestInput({
  "sample-1": {
    method: "sampling/createMessage",
    params: { messages: [], maxTokens: 512 },
  },
});
```

- **Requests are typed.** Each must be a `sampling/createMessage`, `roots/list` or `elicitation/create` request with the fields that request requires. Anything else throws `TypeError` before the task moves.
- **Validation follows the stable `2026-07-28` definitions**: integer `maxTokens`, Base64 binary blocks, an object-rooted tool `inputSchema`, a string `$schema` wherever a schema carries one, `file://` roots, a valid `url` for URL elicitation, and only text, image, audio, `tool_use` and `tool_result` blocks in sampling messages and results. The fields it accepts loosely (`elicitationId`, `outputSchema`, `structuredContent`, `execution`) and the remaining differences from the schema are in the [contract](contract.md#input-rounds).
- **Keys are unique for the task's whole lifetime**, including after it ends and across a restart. Reusing one throws `DuplicateInputKeyError`.
- **The promise settles exactly once.** It resolves when every key is answered, and rejects if the task is cancelled, finishes another way, expires, or the engine closes. It never leaks.

There is deliberately no hook for the moment the task parks; clients learn the keys by polling `tasks/get`. In a test, poll `getTask` until the status is `input_required`.

### Worker process affinity

The record lives in the `TaskStore`, but the `requestInput()` promise and the `AbortSignal` belong to **the process running the worker**. While a worker is live, `tasks/update` and `tasks/cancel` must reach that instance. Over Streamable HTTP, clients set the `Mcp-Name` header to the task ID on `tasks/get`, `tasks/update` and `tasks/cancel`, so a load balancer can route by it. That routing, or any other coordination between instances, is yours to configure. A built-in broker would make this engine the queue the [non-goals](contract.md#non-goals) exclude ([process boundaries](contract.md#process-boundaries)).

### `resumeInput()`

Claims the answers to a round completed while no worker was waiting, typically after a restart ([durability](durability.md#what-durability-does-not-cover)):

```ts
async function resume(task: TaskHandle) {
  const answers = await task.resumeInput();
  if (answers !== undefined) return continueWith(answers);
  // Nothing arrived yet. A later reply is kept the same way, so either call
  // resumeInput() again later or ask again with new keys.
}
```

- Resolves with the kept responses **exactly once**: the claim is a compare-and-swap write that removes them, even across instances on a shared store.
- Resolves with `undefined`, writing nothing, when there is nothing to claim.
- Throws like any write: `TaskNotFoundError` for a missing or expired task, `TaskAlreadyTerminalError` for a finished one.
- **Call it before `requestInput()`.** A new round, or the end of the task, drops unclaimed answers. The old keys stay spent (I5).

---

## `TaskStore`

Five methods. Implement this to put tasks somewhere else.

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

| Method   | Must                                                                                                            |
| -------- | --------------------------------------------------------------------------------------------------------------- |
| `create` | Not resolve until a later `get()` would find the record. This is the durability promise                         |
| `get`    | Return `undefined` for an unknown id **and** for one whose TTL elapsed                                          |
| `update` | Reject with `ConcurrentUpdateError` when the stored version is not `expectedVersion`; return the written record |
| `sweep`  | Drop expired tasks and return how many. **Never** the records: the extension has no enumeration                 |
| `close`  | Be idempotent                                                                                                   |

Rules that are easy to get wrong, all checked by the conformance kit:

1. **`undefined` in a patch deletes the field**; it never means "leave unchanged". This covers enumerable own string-keyed properties. A task leaving `input_required` clears its requests this way, and `tasks/get` refuses to project a `working` or terminal record that still carries requests.
2. **Every successful `update` bumps `version` by exactly one.**
3. **Hand out copies, not references.** Mutating a returned `result` must not change stored state.
4. **TTL runs from `createdAt` plus the current `ttlMs`**, which may change. Raising it extends the same window; `null` makes the task unlimited from then on.
5. **Persist every field, including ones you do not recognise.** That includes the four internal fields that never reach the wire: `version`, `inputResponses`, `unclaimedInputResponses` (added after `0.3.0`) and `usedInputKeys`. A store with a fixed field list loses answers a client already gave, and one that drops `usedInputKeys` at the terminal transition or on replay breaks key uniqueness after a restart.

---

## `MemoryTaskStore`

```ts
new MemoryTaskStore({ now: () => Date.now() }); // options optional
```

In-process, with no Node built-ins: for tests, development, and servers whose tasks need not outlive the process. Its durability boundary _is_ the process.

---

## `WalTaskStore`

```ts
import { WalTaskStore, DEFAULT_MAX_ENTRY_BYTES } from "mcp-durable-tasks/wal";

const store = new WalTaskStore({ dir: "./data" });
```

Durable across process restarts, on top of [`process-wal`](https://github.com/AndresSaa/process-wal). Reads come from an in-memory index; every mutation is first appended to a write-ahead log, which replays on open.

| Option              | Type                                       | Default    | Meaning                                                                                          |
| ------------------- | ------------------------------------------ | ---------- | ------------------------------------------------------------------------------------------------ |
| `dir`               | `string`                                   | —          | Required. Holds `wal.jsonl` and `wal.checkpoint`                                                 |
| `fsync`             | `boolean`                                  | `false`    | `true` moves the boundary from the page cache to storage                                         |
| `maxEntryBytes`     | `number`                                   | 8 MiB      | Largest encoded task record the log accepts (`DEFAULT_MAX_ENTRY_BYTES`)                          |
| `compactEvery`      | `number \| null`                           | `1_000`    | Superseded entries before an automatic rewrite. `null` disables; otherwise a safe integer `>= 1` |
| `now`               | `() => number`                             | `Date.now` | Injectable clock, for TTL                                                                        |
| `onCompactionError` | `(event: WalCompactionErrorEvent) => void` | —          | Observes a failed automatic compaction                                                           |

Any other `compactEvery` (`NaN`, 0, a negative number) throws `TypeError` before the log opens.

**One process, one directory.** `process-wal` is single-writer and does not lock; two processes on one directory corrupt the log ([durability](durability.md#two-unsupported-configurations)).

### `compact(): void`

Rewrites the log as a snapshot of live tasks and drops everything before it. Runs automatically per `compactEvery`; call it yourself to choose when ([durability](durability.md#compaction)).

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

`TaskEntryTooLargeError` has the stable `code` `ERR_ENTRY_TOO_LARGE`, so a worker can recover instead of losing finished work:

```ts
import { isTaskEntryTooLargeError } from "mcp-durable-tasks";

try {
  await task.complete(hugeResult);
} catch (error) {
  if (!isTaskEntryTooLargeError(error)) throw error;
  await task.complete({ truncated: true, summary: summarise(hugeResult) });
}
```

Prefer `isTaskEntryTooLargeError()` (stable code) and `isConcurrentUpdateError()` (stable name) to `instanceof`: duplicated installations and separate CJS bundles do not share class identity.

There is deliberately **no error for an unrecognised input key**: the extension says a server SHOULD ignore it, so throwing would be a conformance bug.

---

## `mcp-durable-tasks/testing`

The conformance kit. Short version in the [README](../README.md#writing-your-own-store).

| Export                                             | Purpose                                        |
| -------------------------------------------------- | ---------------------------------------------- |
| `runTaskStoreConformance(name, factory, options?)` | Declares the suite in your test runner         |
| `checkTaskStore(name, factory, checks?, options?)` | Runs the checks and returns a report           |
| `conformanceChecks`                                | The check list, if you want to filter it       |
| `conformanceRecord(overrides?)`                    | Builds a valid `TaskRecord` for your own tests |

```ts
runTaskStoreConformance(
  "RedisTaskStore",
  () => ({
    store: new RedisTaskStore({ url }),
    advanceTime: (ms) => clock.advance(ms), // optional
    now: () => clock.now(), // optional, with advanceTime
    reopen: () => new RedisTaskStore({ url }), // optional
    dispose: () => cleanup(), // optional
  }),
  { runner: { describe, it, skip } },
);
```

- The factory is called **once per check** and must return a fresh, isolated store. The kit fails if it sees a reused instance.
- The checks cover the patch rules: `undefined` deletes a field, `null` is a value (`ttlMs: null` comes back as `null`), and `error`, `lastUpdatedAt` and every other patchable field round-trip.
- `advanceTime`, `now` and `reopen` are optional. Checks that need a missing one are **skipped, not passed**.
- `now` returns the store's clock in epoch milliseconds, and the TTL checks stamp their tasks from it. Without it the kit assumes the clock starts at `2026-01-01T00:00:00.000Z`; if yours does not, the TTL checks fail and say to declare `now`.

---

## See also

- [durability.md](durability.md) — what survives what, and why
- [internals.md](internals.md) — how it is put together
- [contract.md](contract.md) — scope, invariants and open conformance questions
- [SECURITY.md](https://github.com/AndresSaa/mcp-durable-tasks/blob/main/SECURITY.md) — the threat model
