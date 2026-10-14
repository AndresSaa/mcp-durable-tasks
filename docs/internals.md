# Internals

How the engine is put together, and why some parts look heavier than they need to be. The package fills the extension's Task Store role, which the TypeScript SDK stopped implementing when Tasks became an extension in the `2026-07-28` revision.

## The one shape that matters

```
tools/call ──▶ TaskLifecycle ──▶ TaskMutator ──▶ TaskStore ──▶ MemoryTaskStore
tasks/get           │             (CAS loop)                    WalTaskStore
tasks/update        │                                           [yours]
tasks/cancel        ▼
              WorkerCoordinator ──▶ TaskHandle ──▶ your worker
              (promises, signals)
```

Two halves that do not mix. **Everything right of `TaskStore` is durable.** Everything in `WorkerCoordinator` is process-local and cannot be otherwise: a promise and an `AbortSignal` do not survive a crash.

## Design decisions

**The store record and the wire shape are two types.** `TaskRecord` has four fields no extension task defines: `version` (compare-and-swap), `inputResponses` (a round in progress), `unclaimedInputResponses` (a completed round no worker was waiting for) and `usedInputKeys` (the lifetime key ledger). The stable `2026-07-28` schema is open and would accept them, so keeping them off the wire is this package's guarantee. `wire.ts` projects with an **allow-list**, not copy-and-delete, so a new internal field stays invisible until someone deliberately lists it.

**Compare-and-swap, not locks.** The 2026 revision is stateless, and several server instances may write the same record; optimistic concurrency works without a lock manager. `WalTaskStore` is single-writer and never loses a race, but implements CAS anyway so there is one contract.

**`undefined` in a patch deletes.** A task leaving `input_required` clears its requests this way. Leaving the key present with `undefined` would make a non-JSON record that memory and a WAL replay represent differently; ignoring it would leave stale requests on a task that no longer waits. Third-party stores get this wrong first, so the conformance kit checks it.

**Stores hand out deep copies.** Otherwise a caller mutating a returned `result` would change stored state behind the compare-and-swap, with no version bump and nothing logged. `record.ts` freezes a `structuredClone` on the way out of both stores.

**Payloads are validated as JSON before commit.** `json.ts` rejects a `Map`, a `Date`, a cycle: anything `structuredClone` keeps but `JSON.stringify` flattens. Without it the two stores disagree (memory returns the `Map`, the WAL returns `{}` after a restart).

**Cancellation changes no status.** `tasks/cancel` only raises the signal. The spec says cancellation is eventually consistent and a task may end elsewhere, so only the worker knows when it has stopped. That is why `TaskHandle.cancelled()` exists; without it, `cancelled` would be unreachable.

**TTL is measured from `createdAt`**, not from when `ttlMs` last changed. Raising it extends the same window; `null` makes the task unlimited from then on.

## Source layout

| File                    | Job                                                                          |
| ----------------------- | ---------------------------------------------------------------------------- |
| `types.ts`              | The public contract, and nothing else                                        |
| `index.ts`              | The main entry point's re-exports                                            |
| `lifecycle.ts`          | The protocol-facing state machine                                            |
| `task-mutator.ts`       | Read, decide, compare-and-swap, retry — the single write path                |
| `worker-coordinator.ts` | Process-local promises and abort signals                                     |
| `handle.ts`             | The worker's write side                                                      |
| `wire.ts`               | `TaskRecord` → `DetailedTask`, allow-list based                              |
| `input.ts`              | Runtime validation of the three MCP input request/result shapes              |
| `input-round.ts`        | The `tasks/update` merge rule, as a pure function                            |
| `json.ts`               | JSON-value validation                                                        |
| `record.ts`             | Rules both stores share: expiry, patch merge, snapshot                       |
| `memory-store.ts`       | The dependency-free store                                                    |
| `wal.ts`                | The durable store, `mcp-durable-tasks/wal`                                   |
| `conformance.ts`        | The checks a `TaskStore` must pass                                           |
| `testing.ts`            | `mcp-durable-tasks/testing` — the kit's public surface                       |
| `validation.ts`         | Small shared argument guards                                                 |
| `errors.ts`             | Every error class, including `TaskCancelled` (a signal reason, never thrown) |

- `types.ts` is large on purpose: the whole public contract in one file.
- `conformance.ts` is a list of independent checks; splitting it would scatter one product.
- `lifecycle.ts` orchestrates, so it grows with the methods it serves. Anything that can leave without dragging lifecycle state along should, as the persistence loop (`task-mutator.ts`), process-local coordination (`worker-coordinator.ts`) and the merge rule (`input-round.ts`) already did.
- The merge rule is the sharpest algorithm here and has had a finding in every audit (prototype-named keys, partial rounds, duplicate delivery, a decision surviving a lost CAS). As a pure function of three values, its cases test directly as a table.

## Why `input.ts` is not a schema validator

A JSON Schema validator would add a dependency to the main entry point, so `input.ts` checks the shapes structurally. The test suite checks it against the stable `2026-07-28` schema snapshot with a real validator. Rules where the snapshot was more permissive now follow its base types; the remaining differences are listed in [input rounds](contract.md#input-rounds) (see also [A8](contract.md#extension-conformance-questions)).

## Why the compatibility seam stays in the host

On a `2026-07-28` server built with `@modelcontextprotocol/server` before 2.3.0, the SDK answers `tasks/get` and `tasks/cancel` with `-32601` before any handler runs. Since 2.3.0, handlers registered with an explicit schema serve all three methods (A6), and the crash-recovery example uses that with no workaround. A host on an older SDK keeps its own narrow workaround; the package ships neither a seam nor a client entry point (the requester side belongs to `@modelcontextprotocol/ext-tasks/client`). The measurements and both known workarounds are in the [SDK compatibility profile](contract.md#typescript-sdk-v2-compatibility).

## Cost profile

Reads are a map lookup plus a `structuredClone`, and never touch the filesystem. Writes are one synchronous append; `WalTaskStore` inherits `process-wal`'s cost, which depends mostly on `fsync`.

Log size is bounded by compaction, not task count: a task updated a thousand times leaves 999 superseded entries until a rewrite reclaims them. There is no benchmark here yet; `process-wal` measures the layer underneath, and one belongs here only to back a claim about the engine's own overhead.

## See also

- [api.md](api.md) — the full surface
- [durability.md](durability.md) — what survives what
- [contract.md](contract.md) — scope, invariants and open conformance questions
