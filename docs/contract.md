# Contract and conformance profile

This is the repository-level contract for `mcp-durable-tasks`: scope,
invariants, implementation choices forced by the MCP Tasks extension, and the
open conformance questions that can still change the pre-1.0 API. The detailed
TypeScript surface is in [api.md](api.md), and storage guarantees are in
[durability.md](durability.md).

## Contents

- [Scope and authority](#scope-and-authority)
- [Package surface](#package-surface)
- [State model](#state-model)
- [Wire contract](#wire-contract)
- [Input rounds](#input-rounds)
- [Store invariants](#store-invariants)
- [Process boundaries](#process-boundaries)
- [TypeScript SDK v2 compatibility](#typescript-sdk-v2-compatibility)
- [Extension conformance questions](#extension-conformance-questions)
- [Verification](#verification)
- [Version contract](#version-contract)
- [Non-goals](#non-goals)

## Scope and authority

This package implements the server-side state engine and Task Store role of the
MCP Tasks extension (`io.modelcontextprotocol/tasks`, SEP-2663). It also gives a
server's worker a `TaskHandle` for durable progress, input, cancellation and
terminal transitions. It does not implement the client, transport, protocol
negotiation or worker scheduling.

The sources for protocol behavior are, in order:

1. [Tasks extension specification](https://tasks.extensions.modelcontextprotocol.io/specification/draft/tasks.html)
2. [Official extension schema and TypeScript types](https://github.com/modelcontextprotocol/ext-tasks/tree/main/schema)
3. [SEP-2663](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2663-tasks-extension.md)
4. [TypeScript SDK v2 migration notes](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28)
5. The source of the exact SDK version being integrated

The Tasks extension postdates the behavior most tools associate with MCP
Tasks. Do not infer method names or fields from the retired `2025-11-25`
protocol vocabulary. In particular, this extension has no `tasks/list`, and
the absence of global enumeration is a security boundary.

For repository changes, this file owns scope, invariants and conformance
decisions; [api.md](api.md) owns signatures; [durability.md](durability.md) owns
storage guarantees; and the code wins if documentation is temporarily stale.
Any divergence is a documentation defect and must be corrected in the same
change.

## Package surface

| Entry point                 | Contents                         | Runtime requirement |
| --------------------------- | -------------------------------- | ------------------- |
| `mcp-durable-tasks`         | engine, `MemoryTaskStore`, types | none                |
| `mcp-durable-tasks/wal`     | `WalTaskStore`                   | `process-wal` peer  |
| `mcp-durable-tasks/testing` | store conformance kit            | none                |

The main entry point has zero runtime dependencies and imports no Node
built-ins. `process-wal` is an optional peer used only by `/wal`.

## State model

The observable states are:

| State            | Meaning                                      | Terminal |
| ---------------- | -------------------------------------------- | -------- |
| `working`        | the worker is running                        | no       |
| `input_required` | the worker is waiting for client input       | no       |
| `completed`      | the final result is available                | yes      |
| `failed`         | the final error is available                 | yes      |
| `cancelled`      | the worker acknowledged cooperative stopping | yes      |

Legal transitions are:

```text
working ───────────────▶ working
working ───────────────▶ input_required
input_required ────────▶ input_required
input_required ────────▶ working
working|input_required ─▶ completed|failed|cancelled
```

No transition leaves a terminal state. `tasks/cancel` records cancellation
intent and aborts the process-local signal; it does not force a terminal state.
The worker calls `cancelled()` only when it actually honours the request, and
may still complete or fail if work wins the race.

## Wire contract

- Task creation returns `resultType: "task"`. Get, update and cancel return
  `resultType: "complete"`. These discriminators are always explicit.
- `TaskRecord.version`, stored input responses and the lifetime key ledger are
  internal fields and never appear in `tasks/get`.
- The wire task is a closed shape. A status-specific payload is present only in
  its matching state: `result` for `completed`, `error` for `failed`, and live
  `inputRequests` for `input_required`.
- `createdAt` and `lastUpdatedAt` are ISO 8601 timestamps.
  `lastUpdatedAt >= createdAt` and never moves backwards, even if the injected
  clock does.
- TTL is measured from `createdAt`, including after a TTL update. `null` means
  no expiry. Reads of expired tasks return not found, and replay discards them.
- `pollIntervalMs` is an optional hint. `defaultPollIntervalMs: null` omits it;
  `undefined` selects the 1,000 ms library default.
- Results, errors, input payloads and direct store records must be recursive
  plain JSON before mutation. Cycles, holes, `undefined`, non-finite numbers,
  `bigint`, functions, symbols, `Map`, `Set`, `Date` and custom prototypes are
  rejected. The valid JSON number `-0` is canonicalised to `0` in both stores
  before mutation, matching a JSON encode/decode cycle.

## Input rounds

`inputRequests` carries the existing MCP sampling, elicitation and roots
request shapes; it is not a free-form application channel. The corresponding
responses use the matching MCP result shapes.

The generated extension `schema.json` currently loses these unions because
their SDK imports are unresolved during schema generation. It reduces both
`InputRequest` and `InputResponse` to unconstrained branches. Runtime validation
therefore follows the source types from
[`@modelcontextprotocol/sdk@1.30.0`](https://github.com/modelcontextprotocol/typescript-sdk/blob/1.30.0/src/types.ts),
including nested content blocks, Base64 binary content, `file://` roots,
primitive elicitation schemas and URL elicitation fields.

The round-trip rules are:

- A request key is unique for the entire life of one task, across rounds and
  terminal transitions.
- The store persists `usedInputKeys`; replay cannot make an old key reusable.
- Partial responses are accepted. The task remains `input_required` until all
  live keys have answers.
- Responses for unknown, already answered or otherwise non-live keys are
  ignored. A mixed update applies live keys and discards the others.
- Local waiters are registered before `input_required` becomes observable and
  settle only from a committed store update. A losing CAS candidate cannot
  release a waiter.
- Completing, failing, cancelling, expiring or closing rejects any outstanding
  process-local waiter exactly once.

## Store invariants

The numbered invariants are stable references for tests, reviews and third-party
store implementations:

- **I1 — Durable creation.** `createTask()` does not return until the task is
  readable at the selected store's documented durability boundary.
- **I2 — Terminality.** No transition leaves `completed`, `failed` or
  `cancelled`.
- **I3 — Pure reads.** `tasks/get` performs no mutation, including timestamp
  updates.
- **I4 — Monotonic time.** `lastUpdatedAt` never predates `createdAt` or a
  previous committed value.
- **I5 — Lifetime input keys.** A request key is never reused within one task.
- **I6 — Unpredictable IDs.** Task IDs use `crypto.randomUUID()` or equivalent
  128-bit cryptographic randomness. They are not counters, timestamps or
  argument-derived hashes.
- **I7 — No enumeration.** No public API lists all tasks. `sweep()` returns a
  count, never records or identifiers.
- **I8 — Crash recovery.** After process death and reopen, `WalTaskStore`
  recovers every acknowledged live state, including terminal payloads until
  TTL expiry. The exact host-loss boundary depends on `fsync`; see
  [durability.md](durability.md).

`TaskStore.update()` is compare-and-swap. It rejects a stale
`expectedVersion`, increments the version exactly once on commit, and applies
only enumerable own string-keyed patch properties. `undefined` deletes a field.
CAS protects the durable record; it does not route process-local worker effects.

`WalTaskStore` compaction rewrites a snapshot of all live records before
checkpointing and compacting old entries. A terminal transition is not itself
a checkpoint: doing that would erase the terminal result on reopen. Automatic
compaction runs after its triggering mutation is durable; its failure is
observable without turning that committed mutation into a rejection.

## Process boundaries

`WalTaskStore` is single-process, single-writer and local-disk storage. Two
processes writing one directory are unsupported and can corrupt it. Stateless
or multi-instance servers need a `TaskStore` backed by their shared database.

The durable record may be shared, but a live worker's `AbortSignal` and the
promise returned by `requestInput()` belong to that worker process. While the
worker is alive, `tasks/update` and `tasks/cancel` must reach the same instance
through sticky routing or host-provided coordination. After a crash, the
application resumes from durable state; JavaScript continuations are not
durable.

## TypeScript SDK v2 compatibility

Measured on 10 August 2026 with `@modelcontextprotocol/server` 2.0.0 and a
`2026-07-28` server:

- `tasks/get` and `tasks/cancel` are rejected with `-32601` before registered
  handlers or `fallbackRequestHandler` run.
- `tasks/update` is registrable as a custom method.
- The cause is the protocol-era gate: get and cancel belong to the retired
  `2025-11-25` registry, while update is not claimed by any bundled era.
- Two workarounds are verified, both below the SDK's method dispatch. Renaming
  get and cancel at the `transport.onmessage` seam was measured here and works.
  The MCP Inspector instead answers modern `tasks/*` POSTs in HTTP middleware
  before `createMcpHandler` sees them, and on the client side sends the
  requests as raw `transport.send()` frames
  (`test-servers/src/modern-tasks.ts`, `core/mcp/inspectorClient.ts`).
  Intercepting above the SDK avoids fighting the era gate at all and is the
  better starting point for a host.
- The output codec defaults a missing `resultType` to `"complete"` even for a
  `2026-07-28` server. It accepts and preserves an explicit `"task"` value.

This package emits every discriminator explicitly, but it does **not** ship the
transport rename seam in `v0.1.0`. A host using this SDK version still needs its
own narrowly scoped workaround. The package must not grow that workaround into
transport ownership, authentication or version negotiation.

## Extension conformance questions

These are questions for `modelcontextprotocol/ext-tasks`, not undocumented
features to invent locally:

| ID  | Status   | Question or settled interpretation                                                                                                                                         |
| --- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Open     | The extension overview uses `-32003` for missing client capability, while the SDK v2 migration guide uses `-32021` for `2026-07-28`. Which code governs the extension?     |
| A2  | Settled  | Partial input response sets are legal; the server ignores non-live keys.                                                                                                   |
| A3  | Settled  | TTL remains anchored to `createdAt`; changing it does not restart the clock.                                                                                               |
| A4  | Settled  | Cancellation is eventually consistent and does not force `cancelled`.                                                                                                      |
| A5  | Settled  | Input request keys are unique for the full lifetime of a task.                                                                                                             |
| A6  | Open     | Should a server declaring the Tasks extension bypass the SDK era gate for `tasks/get` and `tasks/cancel`, or is transport rewriting expected?                              |
| A7  | Open     | If a server implements optional `notifications/tasks`, are notifications replayed after a crash or is polling always authoritative?                                        |
| A8  | Open bug | The generated JSON Schema does not preserve the SDK input request/response unions. Should the schema inline or bundle those definitions?                                   |
| A9  | Open     | Does the extension assume sticky routing, host coordination, or another delivery mechanism for input/cancellation while a worker lives on another instance?                |
| A10 | Open bug | Should the SDK default an absent result discriminator to `"complete"` when the server declares the Tasks extension, silently converting a task handle into a final result? |

Before filing or updating the conformance report, re-read the current spec,
SDK source and open `ext-tasks` pull requests. An upstream change may close a
question without a package change.

## Verification

- Schema tests pin the official `schema.json` and `schema.ts` fixtures and make
  protocol drift explicit. `pnpm check:schema` performs the network comparison.
- The conformance kit runs against both included stores and deliberately broken
  stores. Optional clock and reopen capabilities are reported as real skips,
  never false passes.
- Crash tests use child processes, explicit IPC commit points and real
  `SIGKILL`; they load `dist/`, not source files.
- The property-based state machine generates progress, TTL and clock changes,
  partial and duplicate inputs, cancellation, terminal races and foreign CAS
  conflicts, comparing complete records, wire projections and worker effects
  after every step.
- CI runs Node 22 and 24 on Linux, macOS and Windows. Node Current is
  informative. Package validation checks CJS, ESM, declarations and a tarball
  installed without the optional WAL peer.

## Version contract

- `0.1.0`: engine, both stores, conformance kit and crash tests; first npm
  publication, performed manually with 2FA and without provenance to establish
  the registry package.
- `0.2.0`: crash-recovery demo and first automated npm publication through
  trusted publishing, OIDC and provenance.
- `0.3.0`: optional client driver candidate, not started before `0.2.0`.
- `1.0.0`: open extension questions are closed or recorded as explicit package
  decisions, and `TaskStore`/`TaskLifecycle` become frozen semver contracts.

Before `1.0.0`, a breaking API change is a minor release with a clear changelog
entry. After `1.0.0`, normal major-version rules apply.

## Non-goals

Without prior maintainer discussion, this repository does not add:

- a second package, monorepo or package family;
- framework adapters or workflow-engine bridges;
- Redis, Postgres, SQLite, D1 or other community stores in this repository;
- the retired `2025-11-25` task vocabulary;
- queues, retries, backoff, priorities, scheduling, cron or dead-letter logic;
- a CLI, dashboard or replay viewer;
- transport, authentication or version negotiation;
- encryption, compression or configurable payload serialization;
- a fork, vendored copy or local modification of `process-wal`; or
- the npm name `mcp-ext-tasks`, which should remain available to the official
  extension maintainers.

This is an importable library, not an MCP server added to `mcp.json`, and not a
to-do manager.
