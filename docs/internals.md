# Internals

Design decisions, the source layout, and the things that look like
over-engineering until you know what went wrong without them.

## The one shape that matters

```
tools/call ──▶ TaskLifecycle ──▶ TaskMutator ──▶ TaskStore ──▶ MemoryTaskStore
tasks/get           │             (CAS loop)                    WalTaskStore
tasks/update        │                                           [yours]
tasks/cancel        ▼
              WorkerCoordinator ──▶ TaskHandle ──▶ your worker
              (promises, signals)
```

Two halves that do not mix. **Everything to the right of `TaskStore` is
durable**; everything in `WorkerCoordinator` is process-local by nature and
cannot be otherwise. A promise and an `AbortSignal` do not survive a crash, and
pretending they might would be the sort of lie this package exists to avoid.

## Design decisions

**The store record and the wire shape are two types.** Every task variant in
the extension's schema sets `additionalProperties: false`, and a `TaskRecord`
carries three fields no conforming response may contain: `version` for
compare-and-swap, `inputResponses` for a round in progress, and `usedInputKeys`
for the lifetime key ledger. `wire.ts` projects one onto the other with an
**allow-list**, not a copy-and-delete — the difference is that a new internal
field is invisible to the wire until someone deliberately lists it, instead of
leaking until someone remembers to exclude it.

**Compare-and-swap rather than locks.** The 2026 revision is stateless and
several server instances may write the same record. Optimistic concurrency is
the only thing that works without a lock manager, and `WalTaskStore` — which is
single-writer and can never lose a race — implements it anyway so there is one
contract rather than two.

**`undefined` in a patch deletes.** It does not mean "leave unchanged". A task
leaving `input_required` clears its requests that way, and a spread that left
the key present holding `undefined` would emit a property the wire shape
forbids. This is the rule a third-party store gets wrong first, so the
conformance kit checks it explicitly.

**Stores hand out deep copies.** A caller who mutated a returned `result` in
place would change stored state behind the compare-and-swap — no version bump,
nothing logged, and nothing to find later. `record.ts` freezes a
`structuredClone` on the way out of both stores.

**Payloads are validated as JSON before anything is committed.** `json.ts`
rejects a `Map`, a `Date`, a cycle — anything `structuredClone` would keep but
`JSON.stringify` would flatten. Without it, `MemoryTaskStore` and
`WalTaskStore` disagree about what a task holds: the in-memory one returns the
`Map`, and the WAL returns `{}` after a restart. Accepting a value in memory
that the log corrupts is worse than rejecting it at the call.

**Cancellation changes no status.** `tasks/cancel` raises the signal and stops.
The specification is explicit that cancellation is eventually consistent and a
task may end somewhere other than `cancelled`, so only the worker knows when it
has actually stopped — which is why `TaskHandle.cancelled()` exists. Without
it, `cancelled` would be unreachable.

**TTL is measured from `createdAt`.** Not from when `ttlMs` last changed.
Raising it extends the same window; setting it to `null` makes the task
unlimited from that moment, retroactively included.

## Source layout

| File                    | Job                                                             |
| ----------------------- | --------------------------------------------------------------- |
| `types.ts`              | The public contract, and nothing else                           |
| `index.ts`              | The main entry point's re-exports                               |
| `lifecycle.ts`          | The protocol-facing state machine                               |
| `task-mutator.ts`       | Read, decide, compare-and-swap, retry — the single write path   |
| `worker-coordinator.ts` | Process-local promises and abort signals                        |
| `handle.ts`             | The worker's write side                                         |
| `wire.ts`               | `TaskRecord` → `DetailedTask`, allow-list based                 |
| `input.ts`              | Runtime validation of the three MCP input request/result shapes |
| `input-round.ts`        | The `tasks/update` merge rule, as a pure function               |
| `json.ts`               | JSON-value validation                                           |
| `record.ts`             | Rules both stores share: expiry, patch merge, snapshot          |
| `memory-store.ts`       | The dependency-free store                                       |
| `wal.ts`                | The durable store, `mcp-durable-tasks/wal`                      |
| `conformance.ts`        | The checks a `TaskStore` must pass                              |
| `testing.ts`            | `mcp-durable-tasks/testing` — the kit's public surface          |
| `validation.ts`         | Small shared argument guards                                    |

Two files are larger than the others for reasons rather than by accident.
`types.ts` is the whole public contract in one place, so a consumer can read
what they get without opening anything else. `conformance.ts` is a list of
independent checks; splitting it would scatter one product across files.

`lifecycle.ts` is the one to watch. It orchestrates, so its size tracks the
number of methods it serves rather than accumulated responsibility — but that
is an argument, not a licence. Three things have come out of it so far: the
generic persistence loop into `task-mutator.ts`, the process-local coordination
into `worker-coordinator.ts`, and the `tasks/update` merge rule into
`input-round.ts`. Anything else that can leave without dragging the lifecycle's
state with it should.

The merge rule is the clearest case of why. It is the sharpest algorithm here
and the one every audit has found something in — prototype-named keys, partial
rounds, duplicate delivery, a decision surviving a lost compare-and-swap. As a
function of three values it is testable directly, and a table of its cases
reads as the rule it enforces. Inside the lifecycle it needed a store, an
engine and a clock to exercise at all.

Every error class lives in `errors.ts`, including `TaskCancelled` — which is
not thrown by the library but carried as an aborted signal's reason. A
consumer looking for the error catalogue should find all of it in one file.

## Why `input.ts` is not a schema validator

The extension's published `schema.json` is generated from a TypeScript source,
and the generation loses the part that matters here: `InputRequest` and
`InputResponse` are declared as unions of SDK types, those imports do not
resolve, and both degrade to an unconstrained `anyOf`. A validator built on the
JSON Schema alone accepts literally anything as an input request.

So the runtime enforces what the JSON Schema lost, structurally and without a
dependency. This is
[conformance question A8](contract.md#extension-conformance-questions), and it
is one of the stronger items for the conformance report this project is aimed
at.

## The compatibility seam that is not built yet

On a 2026-07-28 server built with `@modelcontextprotocol/server` v2,
`tasks/get` and `tasks/cancel` cannot be served at all: both names belong to
the retired 2025-11-25 method registry, and the protocol-era gate answers
`-32601` before any handler runs — including `fallbackRequestHandler`.
`tasks/update` works, because SEP-2663 introduced it and no era claims the name.

Both known workarounds sit below the SDK's method dispatch. Renaming the two
methods at the `transport.onmessage` seam was measured here and works. The MCP
Inspector takes the other route: it answers modern `tasks/*` POSTs in HTTP
middleware before `createMcpHandler` sees them, and sends them client-side as
raw `transport.send()` frames — which sidesteps the era gate rather than
working around it.

An earlier revision of this file called the rename "the only verified escape".
That was written from the assumption that the Inspector did the same thing, and
the assumption was never checked; it does not. The measurement and the exact
dispatcher code are summarised in the
[SDK compatibility profile](contract.md#typescript-sdk-v2-compatibility). The
seam itself is not shipped, and when it is it stays a narrow method rename
rather than growing into transport ownership.

## Cost profile

Reads are a map lookup plus a `structuredClone`, and never touch the
filesystem. Writes are one synchronous append; `WalTaskStore` inherits
`process-wal`'s cost, which is dominated by whether `fsync` is on.

Log growth is bounded by compaction rather than by task count: every mutation
appends a whole record, so a task updated a thousand times leaves 999
superseded entries until a rewrite reclaims them. There is no benchmark in this
repository yet — `process-wal` already measures the layer underneath, and a
number here would only be worth publishing to back a claim about the engine's
own overhead.

## Origin

The MCP Tasks extension defines four roles: Client, Server, Task Store and
Worker. When the 2026-07-28 revision made Tasks an extension, the TypeScript
SDK removed task support from both sides — so the Task Store role had no
implementation, and anyone serving Tasks from TypeScript was writing the state
machine, the TTL, the polling hints and the `inputRequests` round-trip by hand.

Small, tedious, easy to get subtly wrong, and ownerless. That is still the
shape of the problem this solves.

## See also

- [api.md](api.md) — the full surface
- [durability.md](durability.md) — what survives what
- [contract.md](contract.md) — scope, invariants and open conformance questions
