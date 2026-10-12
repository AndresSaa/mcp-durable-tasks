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

The shipped package implements the server-side state engine and Task Store role
of the MCP Tasks extension (`io.modelcontextprotocol/tasks`, SEP-2663). It also
gives a server's worker a `TaskHandle` for durable progress, input, cancellation
and terminal transitions. It is server-side only: the requester side of the
extension is covered by the official
[`@modelcontextprotocol/ext-tasks`](https://www.npmjs.com/package/@modelcontextprotocol/ext-tasks)
package and its `/client` entry point (see
[the client-follower decision](#decision-no-client-follower)). The package
does not own transport, authentication, protocol negotiation or worker
scheduling.

The targeted protocol revision is the stable `2026-07-28` snapshot of the
extension. The upstream `draft` revision is a moving branch and is not a
conformance target. The sources for protocol behavior are, in order:

1. [Tasks extension specification, revision `2026-07-28`](https://tasks.extensions.modelcontextprotocol.io/specification/2026-07-28/tasks.html)
2. [Official extension schema for `2026-07-28`](https://github.com/modelcontextprotocol/ext-tasks/blob/main/schema/2026-07-28/schema.json)
   and its [TypeScript source](https://github.com/modelcontextprotocol/ext-tasks/blob/main/schema/2026-07-28/schema.ts)
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
  `inputRequests` for `input_required`. This is the package's guarantee, not
  the schema's: the stable schema sets no `additionalProperties: false`, so
  it would accept a leaked internal field. The projection is an allow-list,
  tested for every status against records that carry internal and unknown
  fields.
- The stable schema types `ttlMs` and `pollIntervalMs` as integer
  milliseconds within the safe-integer range. The engine enforces that at its
  API: `createTask()`, `progress()` and the `defaultTtlMs` /
  `defaultPollIntervalMs` options throw `TypeError` for a fraction, a
  non-finite or non-number value, or anything beyond
  `Number.MAX_SAFE_INTEGER`, and nothing is written. `ttlMs` must also be
  greater than 0; `pollIntervalMs` has no further bound, as in the schema.
- Records already in a store are not re-validated. A log written before that
  check existed may hold a fractional or out-of-range hint; it still opens,
  because replay checks only that each record is plain JSON, and expiry
  follows the stored value. Such a task's `tasks/get` carries the stored value
  unchanged, and therefore does not conform, until the worker revises it with
  `progress()`. Normalising it on read was rejected: it would make the wire
  disagree with the record that expiry is computed from, and replay never
  writes.
- `statusMessage` must be a string. TypeScript already requires it; at
  runtime, for untyped JavaScript callers, `createTask()`, `progress()` and
  `cancelled()` throw `TypeError` for anything else, and nothing is written.
- The stable schema types `error` as a JSON-RPC error object (`code` integer,
  `message` string). The engine does not enforce that, so `fail()` with an
  arbitrary object produces a `tasks/get` result the schema rejects. Recorded
  as a known defect with expected-fail tests; not fixed yet.
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

The stable `2026-07-28` `schema.json` defines both unions concretely:
`InputRequest` references `CreateMessageRequest`, `ListRootsRequest` and
`ElicitRequest`, and `InputResponse` their three results (A8). Runtime
validation predates that snapshot. It was written from the source types of
[`@modelcontextprotocol/sdk@1.30.0`](https://github.com/modelcontextprotocol/typescript-sdk/blob/1.30.0/src/types.ts),
including nested content blocks, Base64 binary content, `file://` roots,
primitive elicitation schemas and URL elicitation fields, and is checked
against the snapshot's definitions in `test/schema-conformance.test.ts`.

The engine keeps its own structural check rather than trusting the host or
SDK to have validated the payload. `inputRequests` is stored and replayed to
every client that polls, and an accepted response resumes the worker, so an
invalid shape would become an unfulfillable task or a malformed worker input
that outlives the request that carried it; and the main entry point cannot
depend on an SDK to delegate to. What the check must not do is refuse a shape
the targeted revision defines. Three SDK 1.30.0 rules did, and now follow the
`2026-07-28` base types (`spec.types.ts`) instead:

- URL elicitation needs only `message`, `mode: "url"` and a URL. The
  `2026-07-28` shape has no `elicitationId`; a request that still carries the
  `2025-11-25` field is accepted and stored unchanged.
- A sampling tool's `outputSchema` may be any JSON Schema object. Only
  `inputSchema` must be rooted at `type: "object"`, as before.
- A tool result's `structuredContent` may be any JSON value, not only an
  object.

Each of the three is a relaxation: everything accepted before is still
accepted. One rule went the other way, because the check was wider than the
revision. A sampling message's `content`, and a `CreateMessageResult`'s
`content`, are `SamplingMessageContentBlock`s: text, image, audio, `tool_use`
or `tool_result`, alone or in an array. The engine used to admit resource
links and embedded resources there too, because it reused the block set of a
tool result's `content`, which is MCP's wider `ContentBlock`. Such a request
parked the task and made every `tasks/get` non-conforming, and such a result
resumed the worker. Both are now refused with `TypeError`; inside a
`tool_result`, `content` still accepts the full `ContentBlock` set.

With these aligned, the check and the snapshot agree except in these places:

- The engine enforces what the schema states only as a `format` annotation or
  in prose: Base64 for binary content, a parseable URL for URL elicitation and
  `file://` for roots.
- The engine accepts any finite number as an elicitation value, as
  `spec.types.ts` declares; the generated `schema.json` narrows it to integer.
- Found while aligning the three rules above and left for a decision, pinned
  in the same test file: the engine refuses a tool `execution.taskSupport`
  outside `required`/`optional`/`forbidden`, an SDK 1.30.0 field the
  `2026-07-28` `Tool` does not define and the open schema therefore accepts;
  and it accepts a non-string `$schema` inside a tool's `inputSchema` or
  `outputSchema`, which the schema rejects. The second one lets a
  non-conforming request reach `tasks/get`.

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
worker is alive, `tasks/update` and `tasks/cancel` must reach the same instance.
After a crash, the application resumes from durable state; JavaScript
continuations are not durable.

That affinity is the deployment model the extension itself defines. Its
Streamable HTTP binding requires the client to set the `Mcp-Name` header to
`params.taskId` on every `tasks/get`, `tasks/update` and `tasks/cancel`, so
that intermediaries and load balancers can route each request for a task to the
instance holding its state, "which is typically required for correctness"
([spec, _Streamable HTTP: Routing Headers_](https://tasks.extensions.modelcontextprotocol.io/specification/2026-07-28/tasks.html#streamable-http-routing-headers)).
Routing on that header is configured in the host's HTTP infrastructure; this
package does not read headers, own the transport or embed a broker. A host that
cannot route by task ID needs its own coordination between instances.

## TypeScript SDK v2 compatibility

### Upstream fix for the era gate (A6)

The era gate described below was fixed upstream by
[typescript-sdk#2599](https://github.com/modelcontextprotocol/typescript-sdk/pull/2599)
(merged 30 September 2026, closing
[#2598](https://github.com/modelcontextprotocol/typescript-sdk/issues/2598)).
The fix is present in the published `@modelcontextprotocol/server` 2.3.0 and
2.3.1 tarballs and absent from 2.2.0, checked by inspecting each tarball's
bundled source. Its scope is narrow: a `tasks/get` or `tasks/cancel` handler
registered **with an explicit schema**
(`setRequestHandler(method, schemas, handler)`) is exempt from the inbound era
gate. Typed registration and `fallbackRequestHandler` remain era-gated for those
two names.

### Measured with 2.3.1

Measured on 12 October 2026 with `@modelcontextprotocol/server` 2.3.1,
`@modelcontextprotocol/client` 2.3.1 and `@modelcontextprotocol/node` 2.1.1
(Node 24.21.0, Windows 11), against a `2026-07-28` server. The reproduction is
[`examples/conformance-reproductions/era-gate.mts`](../examples/conformance-reproductions/era-gate.mts);
every request carries `MCP-Protocol-Version`, `Mcp-Method` and
`Mcp-Name: <params.taskId>`.

| Registration                        | `tasks/get` | `tasks/update`                  | `tasks/cancel` |
| ----------------------------------- | ----------- | ------------------------------- | -------------- |
| explicit schema `(method, schemas)` | served      | served                          | served         |
| typed `(method, handler)`           | `-32601`    | registration throws `TypeError` | `-32601`       |
| `fallbackRequestHandler` only       | `-32601`    | served by the fallback          | `-32601`       |

- The `-32601` answers come with HTTP 404 and the registered handler never
  runs. Typed registration of `tasks/update` is refused at registration time
  because the name is not a spec method in any bundled era.
- The HTTP entry validates `Mcp-Name` against `params.taskId` for all three
  methods before dispatch. A task request without the header is answered
  `-32020` (HTTP 400) and never reaches the era gate, so a probe that omits it
  measures the header check, not A6. That is why the 2.0.0 reproduction, which
  sent no `Mcp-Name`, stopped measuring A6. The same check is present in the
  2.1.0 and 2.2.0 tarballs by source inspection; 2.0.0 did not apply it.
- The SDK lifts a top-level `params.inputResponses` out of every
  `2026-07-28` request as multi-round-trip material. A schema-registered
  `tasks/update` handler receives `params` without it and finds the
  responses on `ctx.mcpReq.inputResponses`. The SDK first drops entries that
  are not bare response objects (for example a `{ method, result }` wrapper)
  and lists their keys in `ctx.mcpReq.droppedInputResponseKeys`.
- The server encode step stamps `resultType: "complete"` on any result whose
  handler omits it, `tools/call` included, and adds
  `_meta["io.modelcontextprotocol/serverInfo"]`. It keeps an explicit
  `"task"` on `tools/call`, where it also adds an empty `content` array.
- The 2.3.1 client rejects a `2026-07-28` result without `resultType` as
  `INVALID_RESULT`; the absent-means-complete bridge now applies only to
  earlier-revision servers. It still rejects `resultType: "task"` from
  `tools/call` as `UNSUPPORTED_RESULT_TYPE`. See A10.

The crash-recovery example serves all three methods through explicit-schema
handlers on `server` `^2.3.0`, with no HTTP middleware and no transport
rewrite.

### Measured with 2.0.0

Historical. Measured on 10 August 2026 with `@modelcontextprotocol/server`
2.0.0 and a `2026-07-28` server; the reproduction is kept as published at the
`v0.2.1` tag. The request carried no `Mcp-Name` header, which 2.0.0 did not
check:

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

This package emits every discriminator explicitly, but it does **not** ship a
transport rename seam or any SDK compatibility layer. A host on a server
version before 2.3.0 still needs its own narrowly scoped workaround; a host on
2.3.0 or later registers the three methods with explicit schemas, as measured
above.

### Generated schema and the result discriminator

The fixtures are the stable `schema/2026-07-28/` snapshot (`ext-tasks` `main`
at `899c1bb`; the snapshot was last changed by `0d0a6bd` on 24 August 2026),
see `test/fixtures/ext-tasks/PROVENANCE.md`. `test/schema-conformance.test.ts`
validates engine output against it with Ajv 8.20.0 (JSON Schema 2020-12,
strict mode) on every test run:

- The snapshot contains no `additionalProperties: false`. `GetTaskResult`,
  `UpdateTaskResult` and `CancelTaskResult` require `resultType: "complete"`,
  and `CreateTaskResult` requires `"task"`; a result without `resultType`, or
  with the other value, is rejected.
- `createTask()`, and `tasks/get` for `working`, `input_required` (sampling,
  roots and elicitation requests, before and after a partial round),
  `completed`, `failed` and `cancelled`, validate against `GetTaskResult`,
  `DetailedTask` and the matching variant. The `tasks/update` and
  `tasks/cancel` acknowledgements validate, including on a terminal task.
- Because the schema is open, it does not reject internal fields such as
  `version` on a `tasks/get` result. The package's closed wire projection is
  its own guarantee and is tested as such ([wire contract](#wire-contract)).
- The engine defects this validation found are listed under
  [wire contract](#wire-contract) and [input rounds](#input-rounds).

Earlier, on 12 October 2026 and as a one-off check with Ajv 8.17.1, the SDK
2.3.1 wire shapes measured above, with `_meta`, also validated against the
snapshot; that check is not part of the repository. The pre-stable `draft`
fixture this repository vendored until then (`2c1425d`) closed each task
variant with `additionalProperties: false` and never mentioned `resultType`,
so it rejected every `tasks/get` and task-creation result that carries the
discriminator the specification requires. That was a property of the draft
only.

## Extension conformance questions

These are questions for `modelcontextprotocol/ext-tasks`, not undocumented
features to invent locally:

| ID  | Status   | Question or settled interpretation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Settled  | Missing client capability is `-32021`. Every occurrence in the stable `2026-07-28` specification uses it, and its error-handling section requires it for non-declaring clients issuing `tasks/get`, `tasks/update` or `tasks/cancel`, or requesting task notifications on `subscriptions/listen`. The extension overview page still shows `-32003`; that is an upstream documentation mismatch to report, not an open protocol question.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| A2  | Settled  | Partial input response sets are legal; the server ignores non-live keys.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| A3  | Settled  | TTL remains anchored to `createdAt`; changing it does not restart the clock.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| A4  | Settled  | Cancellation is eventually consistent and does not force `cancelled`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| A5  | Settled  | Input request keys are unique for the full lifetime of a task.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| A6  | Settled  | Settled upstream in the SDK, not by a host rewrite: since `@modelcontextprotocol/server` 2.3.0 ([typescript-sdk#2599](https://github.com/modelcontextprotocol/typescript-sdk/pull/2599)), `tasks/get` and `tasks/cancel` handlers registered with an explicit schema bypass the era gate. Measured here on server 2.3.1 with the required `Mcp-Name` header: explicit-schema handlers serve all three methods; typed registration and `fallbackRequestHandler` still answer `-32601` for get and cancel. See [the compatibility profile](#typescript-sdk-v2-compatibility).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| A7  | Open     | The stable specification lets servers push `notifications/tasks`, each carrying a complete `DetailedTask` identical to what `tasks/get` would return at that moment, and lets clients keep polling. It does not say whether notifications missed across a crash or disconnect are replayed, or whether polling is then authoritative. The answer fixes the semantics of the planned `0.3.0` change emitter.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| A8  | Settled  | Settled upstream: [ext-tasks#14](https://github.com/modelcontextprotocol/ext-tasks/issues/14) was closed as completed, and the stable `2026-07-28` `schema.json`, now the vendored fixture, defines `InputRequest`/`InputResponse` as unions of the concrete sampling, roots and elicitation definitions and requires `resultType` on results. Checking the engine's runtime input validation against those definitions found three shapes the engine wrongly refused; they were package defects, not open protocol questions, and are fixed ([input rounds](#input-rounds)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| A9  | Settled  | The extension defines the delivery mechanism: over Streamable HTTP the client sets `Mcp-Name` to `params.taskId` on `tasks/get`, `tasks/update` and `tasks/cancel`, so intermediaries can route every request for a task to the instance holding its state. Routing on it is host infrastructure; see [process boundaries](#process-boundaries).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| A10 | Open bug | Should the SDK default an absent result discriminator to `"complete"` when the server declares the Tasks extension, silently converting a task handle into a final result? Re-measured on server and client 2.3.1: the server still stamps `"complete"` on any result without `resultType`, `tools/call` included, so a task handle that omits its discriminator reaches the client as an empty success; the client still rejects an explicit `"task"` from `tools/call`. The client alone no longer bridges an absent discriminator on `2026-07-28`; it rejects the result as invalid. The stable `2026-07-28` schema requires `resultType` and accepts it on `tasks/get`; only the pre-stable `draft` schema, vendored here until the re-pin, rejected it ([details](#generated-schema-and-the-result-discriminator)). [typescript-sdk#2637](https://github.com/modelcontextprotocol/typescript-sdk/issues/2637) was closed as a duplicate of the SDK's open Tasks-extension tracking issue ([#2189](https://github.com/modelcontextprotocol/typescript-sdk/issues/2189)). |

Before filing or updating the conformance report, re-read the current spec,
SDK source and open `ext-tasks` pull requests. An upstream change may close a
question without a package change.

## Verification

- Schema tests pin the official `schema.json`, `schema.ts` and `spec.types.ts`
  fixtures from the immutable `2026-07-28` snapshot and make protocol drift
  explicit. They validate engine output for every status against that schema
  with a JSON Schema 2020-12 validator (Ajv, a development dependency only),
  test the closed wire projection as the package's own guarantee, and keep
  known engine defects as expected-fail tests that turn red once fixed.
  `pnpm check:schema` performs the network comparison against
  `schema/2026-07-28/`; it also reports, without ever failing, whether the
  upstream `draft` has diverged. It is run by hand and before a tag, not in CI.
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
- `0.2.1`: documentation-only maintenance patch that republishes the corrected
  README to npm; no engine, API or dependency changes.
- `0.2.x`: maintenance patches for documentation, the examples and their SDK
  alignment; no engine or API changes.
- `0.3.0` (preferred next feature): a change emitter for
  `notifications/tasks` on `TaskLifecycle`. After each committed change made
  through that lifecycle, it emits the same closed `DetailedTask` projection
  that `tasks/get` returns. It **emits, it does not deliver**: handling
  `subscriptions/listen`, the acknowledgement and writing to a transport stay
  in the host. Its replay semantics depend on A7, so its readiness gate is an
  A7 answer upstream or an explicit package decision recorded here. Not built.
- `0.4.0` (preferred following feature): first-party `NodeSqliteTaskStore` on
  `mcp-durable-tasks/sqlite`, using Node's built-in `node:sqlite` (subpath
  requires Node 22.13+; the main entry point stays on Node 22). It owns a
  dedicated local file and complements `WalTaskStore` with multi-process local
  CAS; it is not a remote, hosted or application-database adapter. The
  community-store non-goal narrows in that release to this one exception.
- The `0.3.0`/`0.4.0` assignment is delivery order, not an irrevocable version
  reservation. If the emitter gate remains blocked while SQLite has a
  demonstrated need and is otherwise ready, a separate contract-only decision
  may assign SQLite to the next minor. That decision updates this contract,
  `AGENTS.md` and the execution plan before a feature worktree exists;
  implementation never changes the order implicitly.
- `1.0.0`: open extension questions are closed or recorded as explicit package
  decisions, and `TaskStore`/`TaskLifecycle` become frozen semver contracts.

Before `1.0.0`, a breaking API change is a minor release with a clear changelog
entry. After `1.0.0`, normal major-version rules apply.

### Decision: no client follower

Recorded on 12 October 2026 as the contract-only decision this section requires
for any change to the roadmap order. It is not an implementation choice.

The roadmap previously reserved `0.3.0` for an optional
`mcp-durable-tasks/client` task follower. That follower is **removed** from the
roadmap, not rescheduled, and `0.3.0` is reassigned to the change emitter
above. The reasons:

- The extension maintainers now publish
  [`@modelcontextprotocol/ext-tasks`](https://www.npmjs.com/package/@modelcontextprotocol/ext-tasks)
  (first published 17 September 2026; `0.2.2` checked). Its `/client` entry
  point drives tool calls, polling, input and recovery against `2026-07-28`
  Tasks servers. That is the requester role the follower was meant to fill. A
  second, unofficial client here would compete with the official one, and the
  follower was only ever admitted as a narrow exception to the
  [non-goal](#non-goals) against MCP clients.
- The same package has no Task Store, lifecycle engine or `2026-07-28` server
  binding: its `/receiver` entry point targets only `2025-11-25`, and
  `/core/v2` holds wire schemas and type guards. The server-side gap this
  package exists for is still open, so the roadmap stays on that side.
- The follower's readiness gate depended on A6 and A10. A6 is now settled
  upstream, which removes the strongest argument for a package-owned client
  path rather than strengthening it.
- `notifications/tasks` is the one optional server behavior the stable
  specification adds that this package cannot express today, and only the
  engine knows when a task changes. Emitting that change is in scope;
  delivering it is transport and stays out.

An open SDK pull request
([typescript-sdk#2782](https://github.com/modelcontextprotocol/typescript-sdk/pull/2782),
unmerged when this was written) proposes server and client Tasks subpaths with
an in-memory store. If a server-side binding ships upstream, this package's
role relative to it is reassessed in a new contract decision before further
feature work.

## Non-goals

Without prior maintainer discussion, this repository does not add:

- a second package, monorepo or package family;
- framework adapters or workflow-engine bridges;
- Redis, Postgres, D1, `better-sqlite3`, libSQL, Turso, or other community
  stores in this repository. A first-party store on Node's built-in
  `node:sqlite` is the only planned exception: a dedicated local file, no
  driver package, no URLs or credentials. SQLite adapters using any other
  driver remain community packages before and after that release;
- any MCP client or task follower, transport wrapper or SDK compatibility
  layer. The requester side is served by the official
  `@modelcontextprotocol/ext-tasks` `/client` entry point
  ([decision](#decision-no-client-follower));
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
