# Durability

What survives what, where the boundary actually is, and the two configurations
that are unsupported rather than merely discouraged.

## The promise

**A returned `createTask()` means the task is durable.** Not queued, not
scheduled to be written — durable, in the sense that a `tasks/get` for that id
would find it.

That is the extension's own requirement, worded normatively: a server MUST NOT
return a `CreateTaskResult` until the task is durably created. Everything else
in this package is detail around it. It is the whole reason a `TaskStore`'s
`create()` returns a promise at all.

The same holds for every write: when `complete()` resolves, the result has
reached the boundary you configured.

Both included stores validate and canonicalise the same JSON tree before that
mutation. In particular, valid JavaScript `-0` becomes `0` before memory or the
WAL observes it. A live result and the same result after replay therefore use
the same representation instead of relying on `JSON.stringify` to change it
later.

## Where the boundary is

`WalTaskStore` appends to a write-ahead log through
[`process-wal`](https://github.com/AndresSaa/process-wal), which is synchronous
and durable-before-return. Which boundary that is depends on one option.

| Mode                     | Process crash, `SIGKILL`, deploy, container restart | Host loses power                          |
| ------------------------ | --------------------------------------------------- | ----------------------------------------- |
| `fsync: false` (default) | Recoverable                                         | Not guaranteed                            |
| `fsync: true`            | Recoverable                                         | Requests a storage flush before returning |

The default writes reach the kernel page cache. The page cache outlives your
process — it belongs to the operating system, not to you — so it survives a
crash, a `kill -9`, a redeploy and a container restart while the host stays up.
It does not survive the host itself failing.

`fsync: true` asks the OS to push those bytes to storage before the call
returns. The cost is real and it is a property of your filesystem rather than
of this library; `process-wal`'s
[benchmarks](https://github.com/AndresSaa/process-wal/blob/main/docs/benchmarks.md)
measure it between roughly 0.003 ms and 1.5 ms per append depending on mode and
filesystem.

Choose by asking what you are protecting against. Recovering a build that was
running when the editor restarted is the common case, and the default covers
it. A task whose loss costs more than the latency is what `fsync: true` is for.

## What the tests actually prove

The left column above is not an assertion. `test/crash.test.ts` forks real
child processes, kills them with `SIGKILL` at a known state, and reopens the
directory:

| Scenario                                       | After reopen                                              |
| ---------------------------------------------- | --------------------------------------------------------- |
| Task created, nothing else                     | Present, `working`                                        |
| Parked on `input_required`                     | Still parked, with its request keys                       |
| Parked, then reopened                          | Still refuses to reuse a key the dead process issued      |
| `complete()` returned, then killed instantly   | Result intact                                             |
| Acknowledged progress, then killed in appends  | At least that version and value remain                    |
| Torn record at the tail                        | Truncated away, and the next append does not fuse with it |
| TTL elapsed while the process was down         | Gone, and not resurrected by replay                       |
| Killed in a loop of large snapshot compactions | Every task in the confirmed baseline remains complete     |

The signal is sent on an IPC message from the child, not after a sleep. For the
append case that message carries the exact version returned by `progress()`;
for compaction it follows one completed snapshot and precedes a loop of more
large snapshots. The exact write or compaction instruction interrupted remains
scheduler-dependent, but the committed lower bound does not. The child loads
`dist/` — what is proven to recover is the package you install, not the
TypeScript sources nobody runs.

## Recovery on open

Opening a `WalTaskStore` replays the log into an in-memory index:

1. `process-wal` heals a torn tail first. A record interrupted mid-write does
   not end in a newline, and it is truncated **before** any new append is
   accepted — otherwise the next good record would weld onto the garbage and
   both would be lost.
2. Entries replay in order, last write wins. Each entry carries the whole
   record, so replay needs no merging.
3. Tasks whose TTL elapsed while nothing was running are dropped rather than
   resurrected.

A crash therefore costs at most the write that was in flight, which by
definition had not returned — so nothing the library acknowledged is lost.

## Compaction, and the mistake worth naming

Every mutation appends a full record, so a long-lived task's history is almost
entirely superseded. Compaction bounds it: append the current state of every
live task, checkpoint everything before that snapshot, then reclaim.

The obvious alternative is to checkpoint a task the moment it reaches a
terminal status — and it is wrong, silently. `replay()` only returns entries
_after_ the checkpoint, so checkpointing a completed task erases its result on
the next open, while a terminal task must keep that result until its TTL
elapses. **Completion is not when a task stops being needed; expiry is.** This
specification said the wrong thing for a while, and a test now fails if anyone
returns to it.

The snapshot sequence is crash-safe by construction:

- Killed during the snapshot append: the old checkpoint is still active, replay
  sees the old entries plus whatever prefix landed, and last-write-wins
  reconstructs every task.
- Killed after the snapshot but before the checkpoint: the log holds both, and
  the snapshot entries are later.
- Checkpoint replacement and compaction are atomic tmp-then-rename in
  `process-wal`; a failed rename changes nothing.

A failed automatic compaction never fails the mutation that triggered it. That
write was durable before compaction started, and reporting it as failed would
be false. It is reported through `onCompactionError`, and if the failure left
the log unusable, that surfaces on the next operation.

## Size limits

`maxEntryBytes` defaults to 8 MiB per encoded record. A `result` larger than
that throws `TaskEntryTooLargeError` (`code: "ERR_ENTRY_TOO_LARGE"`) and
**commits nothing**, so the task stays where it was and the worker can complete
again with something smaller:

```ts
import { isTaskEntryTooLargeError } from "mcp-durable-tasks";

try {
  await task.complete(result);
} catch (error) {
  if (!isTaskEntryTooLargeError(error)) throw error;
  await task.complete({ truncated: true, summary: summarise(result) });
}
```

The predicate recognises the stable error code across duplicated package
installations and the separate CJS entry bundles; `instanceof` cannot make
that guarantee.

The limit is not there to be annoying. An unbounded record is an unbounded
write and an unbounded replay, and a store that accepts one trades a visible
failure for a worse, later one.

## Two unsupported configurations

These are not caveats. They are configurations where the durability contract
does not hold, and no amount of care in this library changes that.

**Two processes on one directory.** `process-wal` is single-writer and does not
lock. Two writers interleave records and corrupt the log. If you need several
instances, implement `TaskStore` over a store that arbitrates writes — the
interface is five methods, and `mcp-durable-tasks/testing` gives you the suite
before you write the first one.

**Ephemeral filesystems.** A serverless function's disk does not outlive the
invocation, so "durable" means nothing there. `MemoryTaskStore` is the honest
choice in that environment, with tasks that do not outlive the process.

This is why `WalTaskStore` fits stdio MCP servers — Claude Code, Cursor,
VS Code, a local Codex. One process, one disk, and the place where genuinely
long tasks live: builds, test suites, migrations, indexing.

## What durability does not cover

**Worker coordination is not durable, and cannot be.** The promise
`requestInput()` returns and the `AbortSignal` a worker watches live in that
worker's process. After a crash there is no promise to wake — there is the
task's durable status, which is the point. A restarted server reads
`input_required` from the store and can drive the task again; what it cannot do
is resume the suspended function call that was running before.

While a worker _is_ live, `tasks/update` and `tasks/cancel` have to reach its
instance. See [api.md](api.md#worker-process-affinity) and
[the process-boundary contract](contract.md#process-boundaries), including the
open question this raises for the extension itself.

## See also

- [api.md](api.md) — the full surface
- [internals.md](internals.md) — how the pieces fit
- [contract.md](contract.md) — invariants and conformance profile
- [`process-wal`'s durability model](https://github.com/AndresSaa/process-wal/blob/main/docs/durability.md)
  — the layer underneath this one
