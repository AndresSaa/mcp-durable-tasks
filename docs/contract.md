# Contract and conformance profile

The repository contract for `mcp-durable-tasks`: scope, invariants, the choices the MCP Tasks extension forces on the implementation, and the open conformance questions that can still change the pre-1.0 API.

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

The package implements the server-side state engine and Task Store role of the MCP Tasks extension (`io.modelcontextprotocol/tasks`, SEP-2663), and gives a server's worker a `TaskHandle` for durable progress, input, cancellation and terminal transitions. It is server-side only: the requester side belongs to the official [`@modelcontextprotocol/ext-tasks`](https://www.npmjs.com/package/@modelcontextprotocol/ext-tasks) `/client` entry point ([decision](#decision-no-client-follower)). It does not own transport, authentication, protocol negotiation or worker scheduling.

The target is the stable `2026-07-28` revision; the moving upstream `draft` is not. Sources for protocol behavior, in order:

1. [Tasks extension specification, revision `2026-07-28`](https://tasks.extensions.modelcontextprotocol.io/specification/2026-07-28/tasks.html)
2. [Official extension schema for `2026-07-28`](https://github.com/modelcontextprotocol/ext-tasks/blob/main/schema/2026-07-28/schema.json) and its [TypeScript source](https://github.com/modelcontextprotocol/ext-tasks/blob/main/schema/2026-07-28/schema.ts)
3. [SEP-2663](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2663-tasks-extension.md)
4. [TypeScript SDK v2 migration notes](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28)
5. The source of the exact SDK version being integrated

Never infer method names or fields from the retired `2025-11-25` task vocabulary. This extension has no `tasks/list`, and the absence of global enumeration is a security boundary.

This file owns scope, invariants and conformance decisions; [api.md](api.md) owns signatures; [durability.md](durability.md) owns storage guarantees. When docs are stale the code wins, and the divergence is a documentation defect fixed in the same change.

## Package surface

| Entry point                 | Contents                         | Runtime requirement |
| --------------------------- | -------------------------------- | ------------------- |
| `mcp-durable-tasks`         | engine, `MemoryTaskStore`, types | none                |
| `mcp-durable-tasks/wal`     | `WalTaskStore`                   | `process-wal` peer  |
| `mcp-durable-tasks/testing` | store conformance kit            | none                |

The main entry point has zero runtime dependencies and imports no Node built-ins. `process-wal` is an optional peer used only by `/wal`.

## State model

| State            | Meaning                                      | Terminal |
| ---------------- | -------------------------------------------- | -------- |
| `working`        | the worker is running                        | no       |
| `input_required` | the worker is waiting for client input       | no       |
| `completed`      | the final result is available                | yes      |
| `failed`         | the final error is available                 | yes      |
| `cancelled`      | the worker acknowledged cooperative stopping | yes      |

```text
working ───────────────▶ working
working ───────────────▶ input_required
input_required ────────▶ input_required
input_required ────────▶ working
working|input_required ─▶ completed|failed|cancelled
```

No transition leaves a terminal state. `tasks/cancel` records the intent and aborts the process-local signal; it does not force a terminal state. The worker calls `cancelled()` only when it actually stops, and may still complete or fail if the work wins the race.

## Wire contract

- Task creation returns `resultType: "task"`; get, update and cancel return `resultType: "complete"`. The discriminator is always explicit.
- `TaskRecord.version`, stored input responses (`inputResponses`, `unclaimedInputResponses`) and the lifetime key ledger are internal and never appear in `tasks/get`.
- The wire task is a closed shape, built from an allow-list. A status payload appears only in its state: `result` for `completed`, `error` for `failed`, live `inputRequests` for `input_required`. This is the package's guarantee, not the schema's: the schema is open and would accept a leaked field. It is tested for every status against records carrying internal and unknown fields.
- `ttlMs` and `pollIntervalMs` are integer milliseconds no larger than `Number.MAX_SAFE_INTEGER`. `createTask()`, `progress()` and the `defaultTtlMs` / `defaultPollIntervalMs` options throw `TypeError` for anything else (fraction, non-finite, non-number) and write nothing. `ttlMs` must also be greater than 0.
- `statusMessage` must be a string. For untyped callers, `createTask()`, `progress()` and `cancelled()` throw `TypeError` otherwise and write nothing.
- `fail()` takes the exported `TaskError`, `{ code: number; message: string; data?: JsonValue }`: the schema's JSON-RPC error, where `data` is any JSON and extra members are allowed. After the plain-JSON check and before any write, it throws `TypeError` unless `code` is an integer and `message` a string. `code` must be an integer although `spec.types.ts` says `number`, because JSON-RPC 2.0 and the generated schema require one. (`spec.types.ts` types `data` as `unknown`; a stored task narrows it to JSON.) Record and wire types keep `error: JsonObject`.
- `createdAt` and `lastUpdatedAt` are ISO 8601. `lastUpdatedAt >= createdAt`, and it never moves backwards, even if the injected clock does.
- TTL is measured from `createdAt`, also after a TTL update. `null` means no expiry. An expired task reads as not found, and replay discards it.
- `pollIntervalMs` is an optional hint. `defaultPollIntervalMs: null` omits it; `undefined` selects the 1,000 ms default.
- Results, errors, input payloads and direct store records must be recursive plain JSON before mutation. Cycles, holes, `undefined`, non-finite numbers, `bigint`, functions, symbols, `Map`, `Set`, `Date` and custom prototypes are rejected. Both stores turn `-0` into `0`, as a JSON round trip would.
- A stored record that contradicts the state model is corrupt, and the engine refuses it rather than projecting or repairing it. Corrupt means a status payload missing or in the wrong state, or a `status` outside the five above. `tasks/get` throws "Stored task ... is inconsistent". For an unknown status, `tasks/update`, `tasks/cancel` and every worker write throw too: it is not terminal, but writing over it would make a corrupt record look valid.
- Stored records are not re-validated; replay only checks that each is plain JSON. A record written before a check existed (a fractional hint, a failed task's non-JSON-RPC `error`) still opens, expiry follows the stored value, and `tasks/get` serves it unchanged and non-conforming until a write revises it: `progress()` for a hint, never for a terminal `error`, which stays until TTL elapses. Normalising on read was rejected: the wire would disagree with the record expiry is computed from, and replay never writes.

## Input rounds

`inputRequests` carries the MCP sampling, elicitation and roots requests, not free-form application data, and responses use the matching MCP results. The stable `schema.json` defines both unions: `InputRequest` references `CreateMessageRequest`, `ListRootsRequest` and `ElicitRequest`; `InputResponse`, their three results (A8).

The engine validates these shapes itself rather than trusting the host or SDK: `inputRequests` is stored and replayed to every polling client, an accepted response resumes the worker, and the main entry point cannot depend on an SDK. The check derives from the [`@modelcontextprotocol/sdk@1.30.0`](https://github.com/modelcontextprotocol/typescript-sdk/blob/1.30.0/src/types.ts) source types and is tested against the snapshot in `test/schema-conformance.test.ts`. It must never refuse a shape the target revision defines, so where SDK 1.30.0 was stricter it follows the `2026-07-28` `spec.types.ts`:

- URL elicitation needs only `message`, `mode: "url"` and a URL. A request still carrying the `2025-11-25` `elicitationId` is accepted and stored unchanged.
- A sampling tool's `outputSchema` may be any JSON Schema object; only `inputSchema` must be rooted at `type: "object"`.
- A tool result's `structuredContent` may be any JSON value.
- A sampling tool's `execution` is only checked as JSON and is stored unchanged: the `2026-07-28` `Tool` does not define it.

Where the revision is narrower than MCP in general, the check follows the revision:

- Sampling message `content` and `CreateMessageResult` `content` are `SamplingMessageContentBlock`s (text, image, audio, `tool_use`, `tool_result`, alone or in an array). Resource links and embedded resources there throw `TypeError`. Inside a `tool_result`, `content` accepts the full `ContentBlock` set.
- `$schema`, when present on a form elicitation's `requestedSchema` or a sampling tool's `inputSchema`/`outputSchema`, must be a string.

The check and the snapshot still differ in two ways:

- The engine enforces what the schema states only as a `format` or in prose: Base64 binary content, a parseable URL for URL elicitation, `file://` roots.
- Where `spec.types.ts` says `number` and `schema.json` says `integer`, the engine follows the TypeScript, which upstream declares authoritative, and accepts any finite number: elicitation response values, and form `minLength`/`maxLength` and `minItems`/`maxItems`. A fractional limit therefore reaches `tasks/get` and fails the generated schema.

Round-trip rules:

- A request key is unique for the whole life of a task, across rounds and terminal transitions. The store persists `usedInputKeys`, so replay cannot make an old key reusable.
- Partial responses are accepted. The task stays `input_required` until every live key is answered.
- Responses for unknown, already answered or otherwise non-live keys are ignored. A mixed update applies the live keys and drops the rest.
- Local waiters are registered before `input_required` is observable, and settle only from a committed store update. A losing CAS candidate cannot release a waiter.
- Completing, failing, cancelling, expiring or closing rejects any outstanding process-local waiter exactly once.
- The update that completes a round clears the live request and response maps and moves the task to `working`, not back to `input_required`: nothing is outstanding, and the schema's `inputRequests` lists requests that still "need to be fulfilled". If a waiter in this process asked for that exact round, it gets the answers after the commit. Otherwise (after a restart, say) the same update stores them in the internal `unclaimedInputResponses`. The acknowledgement and the wire are the same either way.
- `TaskHandle.resumeInput()` claims retained answers with a CAS that removes them. Exactly one caller receives them, once the removal is durable; any other call returns `undefined` without writing. The keys stay in `usedInputKeys` (I5), so a restarted worker continues instead of asking again.
- Retained answers survive `progress()`. They are dropped by any terminal transition and when the worker opens a new round with `requestInput()`, so a restarted worker calls `resumeInput()` first.
- A waiter is bound to its own round's keys. If an older round completes while a newer `requestInput()` is still being written, the newer waiter does not get the older answers; they are retained, then dropped when the newer round opens.
- Logs written by `0.3.0` or earlier open unchanged. They have no `unclaimedInputResponses`, so a round such a version completed with no worker stays lost, and `resumeInput()` returns `undefined`.
- One narrow case still loses answers: the waiter for the round is rejected (cancellation, expiry or `close()`) after the completing update chose to deliver to it but before it committed. By then the worker was told to stop, the task is gone, or the process is shutting down.

## Store invariants

Stable references for tests, reviews and third-party stores:

- **I1 — Durable creation.** `createTask()` does not return until the task is readable at the store's documented durability boundary.
- **I2 — Terminality.** No transition leaves `completed`, `failed` or `cancelled`.
- **I3 — Pure reads.** `tasks/get` performs no mutation, including timestamp updates.
- **I4 — Monotonic time.** `lastUpdatedAt` never predates `createdAt` or a previous committed value.
- **I5 — Lifetime input keys.** A request key is never reused within one task.
- **I6 — Unpredictable IDs.** Task IDs use `crypto.randomUUID()` or equivalent 128-bit cryptographic randomness, never counters, timestamps or argument-derived hashes.
- **I7 — No enumeration.** No public API lists all tasks. `sweep()` returns a count, never records or identifiers.
- **I8 — Crash recovery.** After process death and reopen, `WalTaskStore` recovers every acknowledged live state, including terminal payloads until TTL expiry and input responses acknowledged while no worker was waiting. The host-loss boundary depends on `fsync`; see [durability.md](durability.md).

`TaskStore.update()` is compare-and-swap. It rejects a stale `expectedVersion`, increments the version exactly once on commit, and applies only enumerable own string-keyed patch properties; `undefined` deletes a field. CAS protects the durable record; it does not route process-local worker effects.

A store persists every `TaskRecord` field, including internal ones it does not use, through `create()`, `update()`, `get()` and, if durable, reopen or replay. Since `0.4.0` that includes `unclaimedInputResponses`: a store with a fixed field list would silently lose answers a client already gave. The conformance kit checks this on update, re-read and reopen. Both included stores keep whole records.

`WalTaskStore` compaction writes a snapshot of all live records, then checkpoints and compacts old entries. Records already expired by its clock are left out and, once the checkpoint commits, dropped from the in-memory index, so memory never holds a task the next open will not replay, even if the clock later steps back. A terminal transition is not a checkpoint: that would erase the result on reopen. Automatic compaction runs after its triggering mutation is durable; its failure is observable but never turns that mutation into a rejection.

## Process boundaries

`WalTaskStore` is single-process, single-writer, local-disk storage. Two processes writing one directory are unsupported and can corrupt it. Stateless or multi-instance servers need a `TaskStore` on their shared database.

A live worker's `AbortSignal` and its `requestInput()` promise belong to its process, even when the record is shared. While the worker lives, `tasks/update` and `tasks/cancel` must reach that instance. After a crash the application resumes from durable state, which includes answers retained for `resumeInput()` ([input rounds](#input-rounds)); JavaScript continuations are not durable.

A lifecycle releases what it holds for a task (a raised cancellation signal whose worker is not, or not yet, running here, and any parked waiter) when the task goes terminal through it, when its TTL elapses by the lifecycle's clock, or on `close()`. Expiry is tracked from the newest record it read or committed, so a TTL revised by another instance is missed; worst case, a signal raised here is dropped at the old expiry, before a worker that never read it starts.

When a task's TTL elapses, the lifecycle also aborts the worker's signal with `TaskNotFoundError`, which is what the task now reads as. The extension leaves stopping work to the server: TTL bounds retention and exposure only ([ext-tasks#11](https://github.com/modelcontextprotocol/ext-tasks/issues/11)). The engine's policy is narrow:

- Cooperative. Nothing is killed; a worker that ignores the signal keeps running, and its next write throws `TaskNotFoundError`.
- Process-local. Only a worker in the process tracking the expiry is told, by that lifecycle's clock, following any TTL revised through it. A worker whose write finds the task already gone from the store gets its signal aborted the same way.
- Nothing is written. No wire change, no new status; replay still discards the task.
- A signal already raised by `tasks/cancel` keeps its `TaskCancelled` reason. A parked `requestInput()` is rejected exactly once, with the same error, before the signal is aborted.
- Reading the signal before any write arms it with one pure read, so a worker that only reads its signal is told too. If the task is already gone, the signal aborts as soon as that read answers. `ttlMs: null` tasks are never aborted this way.

This affinity is the extension's own deployment model. Over Streamable HTTP the client sets the `Mcp-Name` header to `params.taskId` on every `tasks/get`, `tasks/update` and `tasks/cancel`, so load balancers can route a task's requests to the instance holding its state, "which is typically required for correctness" ([spec, _Streamable HTTP: Routing Headers_](https://tasks.extensions.modelcontextprotocol.io/specification/2026-07-28/tasks.html#streamable-http-routing-headers)). That routing is host infrastructure: this package reads no headers, owns no transport and embeds no broker. A host that cannot route by task ID needs its own coordination between instances.

## TypeScript SDK v2 compatibility

The package emits every discriminator explicitly and ships **no** transport rename seam or SDK compatibility layer. On `@modelcontextprotocol/server` 2.3.0 or later, a host registers the three methods with explicit schemas; on earlier versions it keeps its own narrow workaround.

### Upstream fix for the era gate (A6)

[typescript-sdk#2599](https://github.com/modelcontextprotocol/typescript-sdk/pull/2599) (merged 30 September 2026, closing [#2598](https://github.com/modelcontextprotocol/typescript-sdk/issues/2598)) exempts `tasks/get` and `tasks/cancel` handlers registered **with an explicit schema**, `setRequestHandler(method, schemas, handler)`, from the inbound era gate. Typed registration and `fallbackRequestHandler` stay gated for those names. The fix is in the server 2.3.0 and 2.3.1 tarballs and not in 2.2.0 (source inspection).

### Measured with 2.3.1

12 October 2026; `@modelcontextprotocol/server` 2.3.1, `client` 2.3.1, `node` 2.1.1; Node 24.21.0, Windows 11; a `2026-07-28` server. Reproduction: [`examples/conformance-reproductions/era-gate.mts`](../examples/conformance-reproductions/era-gate.mts), sending `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name: <params.taskId>`.

| Registration                        | `tasks/get` | `tasks/update`                  | `tasks/cancel` |
| ----------------------------------- | ----------- | ------------------------------- | -------------- |
| explicit schema `(method, schemas)` | served      | served                          | served         |
| typed `(method, handler)`           | `-32601`    | registration throws `TypeError` | `-32601`       |
| `fallbackRequestHandler` only       | `-32601`    | served by the fallback          | `-32601`       |

- `-32601` comes with HTTP 404 and the handler never runs. Typed `tasks/update` fails because no bundled era defines the name.
- Before dispatch, the HTTP entry checks `Mcp-Name` against `params.taskId` for all three methods and answers `-32020` (HTTP 400) without it, so a probe that omits the header never reaches the era gate. The check is in 2.1.0 and 2.2.0 too (source inspection), not in 2.0.0.
- The SDK moves a top-level `params.inputResponses` out of every `2026-07-28` request: a schema-registered `tasks/update` handler finds it on `ctx.mcpReq.inputResponses`. Entries that are not bare response objects (such as a `{ method, result }` wrapper) are dropped, with their keys in `ctx.mcpReq.droppedInputResponseKeys`.
- The server stamps `resultType: "complete"` on any result without one, `tools/call` included, and adds `_meta["io.modelcontextprotocol/serverInfo"]`. It keeps an explicit `"task"` on `tools/call` and adds an empty `content` array.
- The client rejects a `2026-07-28` result without `resultType` as `INVALID_RESULT` (absent-means-complete applies only to earlier revisions), and still rejects `"task"` from `tools/call` as `UNSUPPORTED_RESULT_TYPE`. See A10.

The crash-recovery example serves all three methods this way on `server` `^2.3.0`, with no middleware or transport rewrite.

### Measured with 2.0.0

Historical: 10 August 2026, `@modelcontextprotocol/server` 2.0.0, a `2026-07-28` server, no `Mcp-Name` header (2.0.0 did not check it); the reproduction is kept at the `v0.2.1` tag.

- `tasks/get` and `tasks/cancel` got `-32601` before any handler or `fallbackRequestHandler` ran, because they belong to the retired `2025-11-25` registry. `tasks/update`, which no era claims, was registrable as a custom method.
- Two workarounds worked below the SDK's dispatch: renaming get and cancel at the `transport.onmessage` seam (measured here), or answering `tasks/*` POSTs in HTTP middleware before `createMcpHandler`, as the MCP Inspector does (`test-servers/src/modern-tasks.ts`; raw `transport.send()` frames client-side in `core/mcp/inspectorClient.ts`). The middleware route is the better starting point for a host.
- The output codec defaulted a missing `resultType` to `"complete"` even on `2026-07-28`, and kept an explicit `"task"`.

### Generated schema and the result discriminator

Fixtures are the stable `schema/2026-07-28/` snapshot (`ext-tasks` `main` at `899c1bb`, last changed by `0d0a6bd` on 24 August 2026; see `test/fixtures/ext-tasks/PROVENANCE.md`). `test/schema-conformance.test.ts` validates engine output against it on every run with Ajv 8.20.0 (JSON Schema 2020-12, strict):

- `GetTaskResult`, `UpdateTaskResult` and `CancelTaskResult` require `resultType: "complete"`; `CreateTaskResult` requires `"task"`. A missing or wrong value fails.
- `createTask()`, and `tasks/get` for every status (`input_required` with sampling, roots and elicitation requests, before and after a partial round), validate against `GetTaskResult`, `DetailedTask` and the matching variant. Update and cancel acknowledgements validate, terminal tasks included.
- The snapshot has no `additionalProperties: false`, so it would not catch an internal field such as `version`; the closed projection is tested separately ([wire contract](#wire-contract)).

A one-off check on 12 October 2026 with Ajv 8.17.1, not kept in the repository, also validated the SDK 2.3.1 wire shapes above, `_meta` included. The pre-stable `draft` fixture vendored until then (`2c1425d`) closed each variant with `additionalProperties: false` and lacked `resultType`, so it rejected every result carrying the required discriminator; that was a draft-only defect.

## Extension conformance questions

Questions for `modelcontextprotocol/ext-tasks`, not features to invent locally:

| ID  | Status   | Question or settled interpretation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Settled  | A missing client capability is `-32021`. The stable specification uses it everywhere and requires it for non-declaring clients calling `tasks/get`, `tasks/update` or `tasks/cancel`, or requesting task notifications on `subscriptions/listen`. The overview page's `-32003` is an upstream docs mismatch, reported as [ext-tasks#31](https://github.com/modelcontextprotocol/ext-tasks/issues/31).                                                                                                                                                                                                                                                                                                            |
| A2  | Settled  | Partial input response sets are legal; the server ignores non-live keys.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| A3  | Settled  | TTL stays anchored to `createdAt`; changing it does not restart the clock.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| A4  | Settled  | Cancellation is eventually consistent and does not force `cancelled`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| A5  | Settled  | Input request keys are unique for the full lifetime of a task.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| A6  | Settled  | Settled upstream, not by a host rewrite: since `@modelcontextprotocol/server` 2.3.0 ([typescript-sdk#2599](https://github.com/modelcontextprotocol/typescript-sdk/pull/2599)), explicit-schema handlers for `tasks/get` and `tasks/cancel` bypass the era gate. See [the compatibility profile](#typescript-sdk-v2-compatibility).                                                                                                                                                                                                                                                                                                                                                                               |
| A7  | Open     | Servers may push `notifications/tasks`, each a complete `DetailedTask` identical to what `tasks/get` would return then, and clients may keep polling. The spec does not say whether notifications missed across a crash or disconnect are replayed, or whether polling is then authoritative. [ext-tasks#24](https://github.com/modelcontextprotocol/ext-tasks/issues/24) proposes a `DetailedTask` snapshot right after acknowledging `subscriptions/listen`, or one client `tasks/get` after subscribing. Our position there: notifications are best-effort, `tasks/get` is authoritative, and a snapshot on subscribe needs no replay log in the emitter. The answer fixes the `0.5.0` emitter's semantics.   |
| A8  | Settled  | Settled upstream ([ext-tasks#14](https://github.com/modelcontextprotocol/ext-tasks/issues/14), completed): the stable `schema.json`, now vendored, defines `InputRequest`/`InputResponse` as unions of the concrete sampling, roots and elicitation definitions and requires `resultType` on results. The shapes the engine wrongly refused were package defects, now fixed ([input rounds](#input-rounds)).                                                                                                                                                                                                                                                                                                     |
| A9  | Settled  | Over Streamable HTTP the client sets `Mcp-Name` to `params.taskId` on `tasks/get`, `tasks/update` and `tasks/cancel`, so intermediaries can route a task's requests to its instance. Routing is host infrastructure ([process boundaries](#process-boundaries)).                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| A10 | Open bug | Should the SDK default an absent result discriminator to `"complete"` when the server declares the Tasks extension, silently turning a task handle into a final result? On 2.3.1 the server still does, `tools/call` included, so a handle that omits it reaches the client as an empty success ([measurements](#measured-with-231)). The stable schema requires `resultType` and accepts it on `tasks/get` ([details](#generated-schema-and-the-result-discriminator)). [typescript-sdk#2637](https://github.com/modelcontextprotocol/typescript-sdk/issues/2637) was closed as a duplicate of the SDK's open Tasks tracking issue [#2189](https://github.com/modelcontextprotocol/typescript-sdk/issues/2189). |

Before filing or updating the conformance report, re-read the current spec, SDK source and open `ext-tasks` pull requests; an upstream change may close a question with no package change.

## Verification

- Schema tests pin `schema.json`, `schema.ts` and `spec.types.ts` from the immutable `2026-07-28` snapshot so protocol drift is explicit ([details](#generated-schema-and-the-result-discriminator)). Ajv is a development dependency only. Known engine defects are kept as expected-fail tests that turn red once fixed. `pnpm check:schema` compares against `schema/2026-07-28/` over the network and reports, without failing, whether upstream `draft` diverged; it runs by hand and before a tag, not in CI.
- The conformance kit runs against both included stores and deliberately broken ones (undefined ignored, `null` read as delete, dropped `error`, frozen `lastUpdatedAt`, dropped fields, fields unknown to an older field list dropped on write or replay, no CAS, live references). It accepts any clock origin the subject declares through `now()`. Optional clock and reopen capabilities are reported as real skips, never false passes.
- Crash tests use child processes, explicit IPC commit points and real `SIGKILL`, and load `dist/`, not source.
- The property-based state machine generates progress, TTL and clock changes, partial and duplicate inputs, cancellation, terminal races and foreign CAS conflicts, and compares complete records, wire projections and worker effects after every step.
- CI runs Node 22 and 24 on Linux, macOS and Windows; Node Current is informative. Package validation checks CJS, ESM, declarations and a tarball installed without the optional WAL peer.

## Version contract

Before `1.0.0`, a breaking API change is a minor release with a clear changelog entry; after it, normal major-version rules apply. The [changelog](../CHANGELOG.md) lists each release's changes.

- `0.1.0`: engine, both stores, conformance kit, crash tests. Published to npm manually, with 2FA and without provenance, to create the registry package.
- `0.2.0`: crash-recovery demo; first publication through trusted publishing, OIDC and provenance.
- `0.2.x` (including `0.2.1`, which republished the corrected README): maintenance for docs, examples and their SDK alignment; no engine, API or dependency changes.
- `0.3.0`: audit hardening and alignment with the stable `2026-07-28` revision; breaking, no new feature. On 13 October 2026 the owner gave it `0.3.0`, since breaking fixes cannot ship as a patch, and moved both planned features one minor later.
- `0.4.0`: known-issues release, decided 14 October 2026; breaking, no new protocol feature. It closes the four defects the `0.3.0` changelog listed (`fail()` type, sampling `$schema` and `execution`, input responses after a restart) and aborts the signal on TTL expiry. Following [ext-tasks#11](https://github.com/modelcontextprotocol/ext-tasks/issues/11), the engine tightens wire shapes and offers a cooperative, process-local signal, and promises nothing more about stopping work.
- `0.5.0` (preferred next feature): a change emitter for `notifications/tasks` on `TaskLifecycle`. After each committed change through that lifecycle, it emits the closed `DetailedTask` projection `tasks/get` returns. It **emits, it does not deliver**: `subscriptions/listen`, its acknowledgement and transport writes stay in the host. Its readiness gate is an upstream answer to A7 or an explicit package decision recorded here. Not built.
- `0.6.0` (preferred following feature): first-party `NodeSqliteTaskStore` on `mcp-durable-tasks/sqlite`, on Node's built-in `node:sqlite` (the subpath needs Node 22.13+; the main entry stays on Node 22). It owns one dedicated local file and adds multi-process local CAS alongside `WalTaskStore`. It is not a remote, hosted or application-database adapter. The community-store non-goal then narrows to this one exception.
- The `0.5.0`/`0.6.0` order is delivery order, not a permanent reservation; it has already moved twice. If the emitter gate stays blocked while SQLite has a demonstrated need and is otherwise ready, a separate contract-only decision may give SQLite the next minor. That decision updates this contract, `AGENTS.md` and the execution plan before a feature worktree exists. Implementation never changes the order implicitly.
- `1.0.0`: open extension questions are closed or recorded as package decisions, and `TaskStore`/`TaskLifecycle` become frozen semver contracts.

### Decision: no client follower

Recorded on 12 October 2026 as a contract-only roadmap decision. The optional `mcp-durable-tasks/client` task follower is **removed** from the roadmap, not rescheduled. Later renumberings of the emitter do not revisit this. Reasons:

- The extension maintainers publish [`@modelcontextprotocol/ext-tasks`](https://www.npmjs.com/package/@modelcontextprotocol/ext-tasks) (first published 17 September 2026; `0.2.2` checked). Its `/client` drives tool calls, polling, input and recovery against `2026-07-28` servers, the role the follower was for. A second, unofficial client would compete with it, and the follower was only ever a narrow exception to the [non-goal](#non-goals) against MCP clients.
- That package has no Task Store, lifecycle engine or `2026-07-28` server binding (`/receiver` targets only `2025-11-25`; `/core/v2` holds wire schemas and type guards). The server-side gap is still open, so the roadmap stays there.
- The follower's gate depended on A6 and A10. A6 is settled upstream, which removes the strongest argument for a package-owned client.
- `notifications/tasks` is the one optional server behavior in the stable specification this package cannot yet express, and only the engine knows when a task changes. Emitting is in scope; delivering is transport.

[typescript-sdk#2782](https://github.com/modelcontextprotocol/typescript-sdk/pull/2782), open and unmerged when this was decided, proposes server and client Tasks subpaths with an in-memory store. If a server-side binding ships upstream, a new contract decision reassesses this package's role before further feature work.

## Non-goals

Without prior maintainer discussion, this repository does not add:

- a second package, monorepo or package family;
- framework adapters or workflow-engine bridges;
- Redis, Postgres, D1, `better-sqlite3`, libSQL, Turso or other community stores. The one planned exception is a first-party `node:sqlite` store: one dedicated local file, no driver package, no URLs or credentials. SQLite adapters on any other driver stay community packages;
- any MCP client or task follower, transport wrapper or SDK compatibility layer ([decision](#decision-no-client-follower));
- the retired `2025-11-25` task vocabulary;
- queues, retries, backoff, priorities, scheduling, cron or dead-letter logic;
- a CLI, dashboard or replay viewer;
- transport, authentication or version negotiation;
- encryption, compression or configurable payload serialization;
- a fork, vendored copy or local modification of `process-wal`;
- the npm name `mcp-ext-tasks`, which should stay available to the official extension maintainers.

This is an importable library, not an MCP server added to `mcp.json`, and not a to-do manager.
