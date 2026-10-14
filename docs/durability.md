# Durability

What survives what, where the boundary is, and the two configurations where the guarantee does not hold.

## The promise

**When `createTask()` returns, the task is durable**: a `tasks/get` for that id would find it. The extension requires this (a server MUST NOT return a `CreateTaskResult` until the task is durably created). Every other write works the same way: when `complete()` resolves, the result has reached the boundary you configured.

Both stores canonicalise the same JSON before writing (`-0` becomes `0`), so a live result and the same result after replay are identical.

## Where the boundary is

`WalTaskStore` appends to a write-ahead log through [`process-wal`](https://github.com/AndresSaa/process-wal), which is synchronous and durable-before-return. One option decides which boundary that is.

| Mode                     | Process crash, `SIGKILL`, deploy, container restart | Host loses power                          |
| ------------------------ | --------------------------------------------------- | ----------------------------------------- |
| `fsync: false` (default) | Recoverable                                         | Not guaranteed                            |
| `fsync: true`            | Recoverable                                         | Requests a storage flush before returning |

By default, writes reach the kernel page cache. That belongs to the OS, not your process, so it survives a crash, `kill -9`, a redeploy and a container restart while the host stays up. It does not survive the host failing.

`fsync: true` asks the OS to push the bytes to storage before the call returns. The cost depends on your filesystem; `process-wal`'s [benchmarks](https://github.com/AndresSaa/process-wal/blob/main/docs/benchmarks.md) measure roughly 0.003 ms to 1.5 ms per append.

The default covers the common case, such as a build that was running when the editor restarted. Use `fsync: true` when losing a task costs more than the latency.

## What the tests prove

`test/crash.test.ts` forks real child processes, kills them with `SIGKILL` at a known state, and reopens the directory:

| Scenario                                       | After reopen                                              |
| ---------------------------------------------- | --------------------------------------------------------- |
| Task created, nothing else                     | Present, `working`                                        |
| Parked on `input_required`                     | Still parked, with its request keys                       |
| Parked, then reopened                          | Still refuses to reuse a key the dead process issued      |
| Answered with no worker, killed, then claimed  | Answers kept until one worker claims them, then gone      |
| `complete()` returned, then killed instantly   | Result intact                                             |
| Acknowledged progress, then killed in appends  | At least that version and value remain                    |
| Torn record at the tail                        | Truncated away, and the next append does not fuse with it |
| TTL elapsed while the process was down         | Gone, and not resurrected by replay                       |
| Killed in a loop of large snapshot compactions | Every task in the confirmed baseline remains complete     |

The kill follows an IPC message from the child, never a sleep: for appends it carries the exact version `progress()` returned, and for compaction it follows one completed snapshot. Which instruction gets interrupted depends on the scheduler; the committed lower bound does not. The child loads `dist/`, so the tests cover the package you install.

## Recovery on open

Opening a `WalTaskStore` replays the log into an in-memory index:

1. `process-wal` heals a torn tail first. A record cut off mid-write has no final newline, and it is truncated **before** any new append, so the next good record cannot weld onto it.
2. Entries replay in order, last write wins. Each entry holds the whole record, so there is no merging. Replay checks only that a record is plain JSON, not the engine's API rules: a log written by an older version, with a fractional `ttlMs` for example, still opens with that value intact ([contract](contract.md#wire-contract)).
3. Tasks whose TTL elapsed while nothing was running are dropped, not resurrected.

A crash costs at most the write in flight, which had not returned. Nothing the library acknowledged is lost.

## Compaction

Every mutation appends a full record, so most of a long-lived task's history is superseded. Compaction bounds it: append the current state of every live task, checkpoint everything before that snapshot, then reclaim.

**Never checkpoint a task when it reaches a terminal status.** `replay()` only returns entries after the checkpoint, so that would erase the result on the next open, while a terminal task must keep its result until its TTL elapses. A task stops being needed at expiry, not at completion. A test fails if anyone does this.

The snapshot sequence is crash-safe:

- Killed during the snapshot append: the old checkpoint still applies, replay sees the old entries plus whatever landed, and last-write-wins rebuilds every task.
- Killed after the snapshot, before the checkpoint: the log holds both, and the snapshot entries come later.
- Checkpoint replacement and compaction are atomic tmp-then-rename in `process-wal`; a failed rename changes nothing.

The snapshot holds only tasks not yet expired by the store's clock. Once the checkpoint commits, the expired ones are removed from the in-memory index too, so a clock that steps back cannot make `get()` serve a task the next open would not find.

A failed automatic compaction never fails the mutation that triggered it: that write was durable before compaction started. The failure goes to `onCompactionError`, and if it left the log unusable, the next operation reports it.

## Size limits

`maxEntryBytes` defaults to 8 MiB per encoded record. A larger `result` throws `TaskEntryTooLargeError` (`code: "ERR_ENTRY_TOO_LARGE"`) and **commits nothing**: the task stays where it was, and the worker can complete again with something smaller ([example](api.md#errors)). The limit exists because an unbounded record means an unbounded write and an unbounded replay.

## Two unsupported configurations

**Two processes on one directory.** `process-wal` is single-writer and does not lock, so two writers interleave records and corrupt the log. For several instances, implement `TaskStore` over a store that arbitrates writes; `mcp-durable-tasks/testing` gives you the suite before you start.

**Ephemeral filesystems.** A serverless function's disk does not outlive the invocation, so "durable" means nothing there. Use `MemoryTaskStore`, with tasks that do not outlive the process.

`WalTaskStore` fits stdio MCP servers, such as those an editor or local coding agent starts: one process, one disk, long tasks.

## What durability does not cover

**Worker coordination is process-local.** The `requestInput()` promise and the `AbortSignal` live in the worker's process. After a crash the task state is there, but the suspended function call cannot be resumed.

**Input responses do survive.** The store keeps the outstanding requests, partial responses and the lifetime key ledger. When a reply completes a round and no worker in this process is waiting (as after a restart), the write that moves the task to `working` also stores the answers in the internal `unclaimedInputResponses` field, at the same boundary as every other write. A restarted worker claims them once with [`resumeInput()`](api.md#resumeinput); the claim survives a crash on either side of its commit. Clients see nothing new on the wire.

Still lost:

- a round that `0.3.0` or earlier completed with no worker, since that log holds no answers;
- answers whose waiter was rejected just after the reply committed, if the process dies or the lifecycle closes before the follow-up write that keeps them ([contract](contract.md#input-rounds)).

`test/crash.test.ts` kills the process after the reply and again after the claim; `test/wal-store.test.ts` covers replay and a `0.3.0` log.

While a worker _is_ live, `tasks/update` and `tasks/cancel` must reach its instance: see [worker process affinity](api.md#worker-process-affinity) and the [process-boundary contract](contract.md#process-boundaries), including the open question it raises for the extension.

## See also

- [api.md](api.md) — the full surface
- [internals.md](internals.md) — how the pieces fit
- [contract.md](contract.md) — invariants and conformance profile
- [`process-wal`'s durability model](https://github.com/AndresSaa/process-wal/blob/main/docs/durability.md) — the layer underneath
