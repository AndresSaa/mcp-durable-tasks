# Changelog

All notable changes to this project are documented here, in
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) order.

This package is pre-1.0. Until `1.0.0`, a breaking change is a **minor** bump
with a clear entry here — normal pre-1.0 semver. `TaskStore` and
`TaskLifecycle` become a frozen contract at `1.0.0`, and from then on breaking
either is a major version.

## [Unreleased]

### Fixed

- **Breaking:** `ttlMs` and `pollIntervalMs` must now be integer milliseconds
  within the safe-integer range, as the stable `2026-07-28` schema requires.
  `createTask()`, `progress()` and the `defaultTtlMs` / `defaultPollIntervalMs`
  constructor options throw `TypeError` for a fraction, `NaN`, `Infinity`, a
  non-number or a value above `Number.MAX_SAFE_INTEGER`, and nothing is
  written. Previously such a value was stored and every `tasks/get` for that
  task failed schema validation. A WAL written before this change still opens
  unchanged; a stored non-integer hint is served as is until the worker
  revises it with `progress()`.
- `progress()`, `cancelled()` and `createTask()` now check at runtime that a
  `statusMessage` is a string and throw `TypeError` otherwise. Only untyped
  JavaScript could pass anything else; it used to be stored and emitted on
  `tasks/get`, which the schema rejects.
- **Behaviour change:** input validation now accepts three shapes the stable
  `2026-07-28` MCP base types define and the SDK 1.30.0 rules it was written
  from refused: URL elicitation without an `elicitationId`, a sampling tool
  whose `outputSchema` is not rooted at `type: "object"`, and a tool result
  whose `structuredContent` is any JSON value rather than an object. Each is a
  relaxation; nothing accepted before is refused now. In the exported types,
  the URL elicitation `elicitationId` is optional, `outputSchema` is a plain
  `JsonObject`, and `structuredContent` is a `JsonValue`. Code that reads
  `structuredContent` from a response as an object must now narrow it first.
- **Breaking:** a sampling message's `content` in `requestInput()`, and the
  `content` of the sampling result that answers it in `updateTask()`, are now
  limited to the `2026-07-28` `SamplingMessageContentBlock` set: text, image,
  audio, `tool_use` and `tool_result`. A `resource_link` or embedded
  `resource` block there used to be accepted, which parked the task with a
  request the schema rejects on every `tasks/get`, or resumed the worker with
  a result the schema rejects; it now throws `TypeError` and nothing is
  written. Both blocks remain valid inside a `tool_result`'s `content`. The
  exported types already excluded them.
- **Breaking:** the `sweepIntervalMs` option of `TaskLifecycle` and the
  `compactEvery` option of `WalTaskStore` are now validated, and an invalid
  value throws `TypeError` from the constructor. `sweepIntervalMs` must be
  `null`, `undefined` or an integer from 1 to 2,147,483,647; Node used to run
  0, a negative value, `NaN`, a non-number or a value above its timer limit
  as a 1 ms sweep loop. `compactEvery` must be `null`, `undefined` or a safe
  integer of at least 1, checked before the log is opened; `NaN` used to
  disable automatic compaction silently, and 0 or a negative count compacted
  after every mutation.
- `cancelTask()` on a task with no worker in this process no longer leaks an
  `AbortController` for the life of the process. The raised signal is still
  kept for a worker that reads it later, but is now released when the task's
  TTL elapses, not only on a terminal transition through the same lifecycle
  or on `close()`. The same expiry now also releases the signal of a worker
  that read it and then stopped writing.
- A stored record whose `status` is not one of the five task states is now
  reported as corrupt, like a record with a missing or misplaced payload.
  `getTask()` used to resolve `undefined` for it, and `complete()`,
  `progress()`, `requestInput()` and the other writes were allowed because
  such a status is not terminal. Every lifecycle method now throws the
  "inconsistent" error and leaves the record unchanged; `cancelTask()` raises
  no signal.
- **Breaking:** a form elicitation whose `requestedSchema.$schema` is present
  but not a string is now refused by `requestInput()` with `TypeError`. Both
  the stable schema and its TypeScript source type it as a string; it used to
  be accepted and stored, and every `tasks/get` for the task then failed
  schema validation.

### Changed

- Defined the gated pre-1.0 roadmap: a change emitter for the optional
  `notifications/tasks` is preferred for `0.3.0` (the engine emits each
  committed change; delivery stays in the host), followed by a first-party
  `node:sqlite` store for one dedicated local file in `0.4.0`. Reassigning that
  order requires a separate contract decision; libSQL, Turso, `better-sqlite3`
  and any MCP client behavior remain out of scope.
- Dropped the planned `mcp-durable-tasks/client` task follower by an explicit
  contract decision. The official `@modelcontextprotocol/ext-tasks/client`
  covers the requester side, and the documentation now presents this package
  as its server-side counterpart.
- Documentation now targets the stable `2026-07-28` revision of the Tasks
  specification and schema instead of the moving `draft`.
- Settled conformance questions A1 (missing client capability is `-32021`), A6
  (the SDK serves `tasks/get` and `tasks/cancel` handlers registered with an
  explicit schema from `@modelcontextprotocol/server` 2.3.0) and A9 (the
  specification routes every request for a task by the `Mcp-Name` header).
  Worker process affinity is unchanged; the documentation now describes it as
  the routing model the specification defines.
- `examples/crash-recovery/` now requires `@modelcontextprotocol/server`
  `^2.3.0` and `@modelcontextprotocol/node` `^2.1.1`, and serves `tasks/get`,
  `tasks/update` and `tasks/cancel` through handlers registered with an
  explicit schema. The HTTP middleware that answered those requests before the
  SDK saw them is gone. `tasks/update` reads its responses from
  `ctx.mcpReq.inputResponses`, because the SDK moves `params.inputResponses`
  there on a `2026-07-28` request, and the demo client now sends the required
  `Mcp-Name` header on task requests.
- `examples/conformance-reproductions/` re-measured A6 and A10 on server and
  client 2.3.1 with `@modelcontextprotocol/node` 2.1.1; the 2.0.0 versions
  stay at the `v0.2.1` tag. With the `Mcp-Name` header the SDK now requires,
  explicit-schema handlers serve all three task methods, while typed
  registration and `fallbackRequestHandler` still answer `-32601` for get and
  cancel. Without it the request is rejected with `-32020` before dispatch,
  which is why the 2.0.0 reproduction no longer measured A6. A10 still
  reproduces on the server: it stamps `resultType: "complete"` on a task
  handle that omits its discriminator. The 2.3.1 client no longer fills in an
  absent discriminator itself. The results and their environment are in
  `docs/contract.md`.
- Recorded that the stable `2026-07-28` schema accepts `resultType` on
  `tasks/get` results and requires it; only the pre-stable `draft` fixture,
  which closes each task variant with `additionalProperties: false`, rejects
  it.
- The vendored extension schema and `pnpm check:schema` now track the
  immutable `schema/2026-07-28/` snapshot instead of the moving `draft`, and
  vendor `spec.types.ts`, which the authoritative `schema.ts` imports its input
  unions from. Conformance question A8 is settled: the stable schema defines
  the input unions concretely. The test suite now validates engine output for
  every task status against that schema; Ajv is a development dependency only,
  and the main entry point still has no runtime dependencies.

### Known issues

Found by validating engine output against the stable `2026-07-28` schema.
Each is pinned by a test in `test/schema-conformance.test.ts` and described in
`docs/contract.md`.

- `fail()` accepts any JSON object, while the schema requires a JSON-RPC error
  with an integer `code` and a string `message` (expected-fail tests).
- Input validation accepts a non-string `$schema` inside a sampling tool's
  `inputSchema` or `outputSchema`, which the schema rejects, so such a request
  reaches `tasks/get` non-conforming. It also still refuses an
  `execution.taskSupport` value outside the SDK 1.30.0 enum, a field the
  `2026-07-28` `Tool` does not define. Both are pinned as current behaviour
  pending a decision.

## [0.2.1] - 2026-08-11

A documentation-only maintenance release. It republishes the corrected README
to npm, whose package pages retain the README bundled with each immutable
version. There are no engine, API or dependency changes.

### Fixed

- The README now identifies `v0.2.1` as the current release, points source
  validation at the current tag, scopes process-crash recovery to confirmed
  state held by `WalTaskStore`, and documents both verified SDK era-gate
  workarounds instead of reverting to the obsolete claim that only transport
  rewriting works.

### Changed

- The optional `0.3.0` client driver is now explicitly gated on upstream
  clarity around A6/A10 or demonstrated user need, so an SDK workaround does
  not become public API merely because `0.2.0` has shipped.

## [0.2.0] - 2026-08-11

The first release published over OIDC with a provenance attestation. No engine
code changed since `0.1.0`: what changed is the runnable evidence that the
central claim holds, and a correction to what the shipped documentation says
about the official SDK.

### Added

- `examples/crash-recovery/`: a real MCP server whose deferred task outlives
  its process. One command starts it, defers work through `tools/call`, kills
  the server with `SIGKILL`, starts it again and reads the finished result back
  from the new process. It asserts the recovered status and result rather than
  narrating them, and it runs on every pull request, so it cannot quietly stop
  being true. The README links a recording of it.
- `examples/conformance-reproductions/`: frozen reproductions of the three
  upstream behaviours reported from this repository, pinned to
  `@modelcontextprotocol/*` 2.0.0. Each one asserts its own finding, so it
  fails when upstream fixes it — reported as
  [ext-tasks#14](https://github.com/modelcontextprotocol/ext-tasks/issues/14),
  [typescript-sdk#2637](https://github.com/modelcontextprotocol/typescript-sdk/issues/2637)
  and a reproduction on
  [typescript-sdk#2598](https://github.com/modelcontextprotocol/typescript-sdk/issues/2598).

### Fixed

- The README banner now resolves on the npm package page. `0.1.0` shipped a
  repository-relative path that only rendered on GitHub, and npm freezes a
  published README, so the fix could not reach that version.

### Changed

- The SDK compatibility profile in `docs/contract.md` and `docs/internals.md`
  now records two verified workarounds for `tasks/get` and `tasks/cancel`
  instead of one. Answering those requests above the SDK, in HTTP middleware,
  sidesteps the protocol-era gate rather than working around it, and is the
  better starting point for a host; the `transport.onmessage` rename still
  works. An earlier revision called the rename "the only verified escape",
  which was assumed rather than measured.

## [0.1.0] - 2026-08-10

First public release. The GitHub tag and Release are followed by the one-time
manual npm publication used to establish the package; automated trusted
publishing with provenance starts with the next version.

### Added

- Stable `isTaskEntryTooLargeError()` and `isConcurrentUpdateError()` guards
  for recognising errors across duplicated packages and separate CJS bundles.
- The lifecycle engine, in-memory store, typed input round-trip, TTL handling,
  CAS retries and schema-safe wire projection.
- `WalTaskStore` on the `mcp-durable-tasks/wal` entry point: durable across
  process restarts, with an in-memory read index and a write-ahead log that
  replays on open. `process-wal` stays an optional peer, so the main entry
  point still costs no dependencies.
- The vendored `ext-tasks` schema, pinned by blob SHA, plus
  `pnpm check:schema` to detect and refresh upstream drift.
- An English repository contract for scope, invariants, conformance decisions
  and version boundaries, plus `docs/api.md`, `docs/durability.md` and
  `docs/internals.md`; all four are shipped in the package for offline use.
- Crash tests over real child processes and real `SIGKILL`, covering task
  creation, a parked input round, an instant-terminal completion, a kill during
  appends, a compaction loop, and a TTL that elapsed while nothing was running.
  The append child reports an acknowledged version as a recovery lower bound;
  the compaction child reports a complete multi-task snapshot. They run against
  the built package rather than the sources.
- The store conformance kit on `mcp-durable-tasks/testing`:
  `runTaskStoreConformance()` declares the suite in your own runner, and
  `checkTaskStore()` returns a report without needing one. It carries no
  dependencies and passes against both included stores.
- Regression coverage for prototype-named input keys, losing CAS candidates,
  waiter registration, terminal/TTL settlement and public API boundaries.
- A fast-check state-machine suite that generates progress, TTL and clock
  schedules, input rounds, cancellation, terminal races and foreign CAS
  conflicts, checking record/wire parity and exactly-once waiter effects after
  every operation.

### Fixed

- Protocol results now carry their required discriminator: task creation uses
  `resultType: "task"`, while get, update and cancel use
  `resultType: "complete"`.
- Valid JSON containing `-0` is canonicalised to `0` before either store
  mutates, keeping live state, worker responses and WAL replay identical.
- Task results, errors, input payloads, and direct store records now reject
  non-JSON trees before mutation, keeping memory and WAL replay identical.
- Automatic WAL compaction failures no longer make an already-durable mutation
  appear rejected. They are observable through `onCompactionError`, and a WAL
  poisoned during snapshot writing fails the next store operation explicitly.
- Input waiters now register before `input_required` becomes observable and
  settle only from committed writes.
- Terminal results and store snapshots no longer share mutable references with
  callers.
- Invalid TTLs and malformed MCP input requests/responses are rejected before
  they can create an unreadable or unfulfillable task. Validation now follows
  nested sampling content blocks, primitive elicitation schemas and response
  values rather than accepting any JSON object at those boundaries.
- MCP input validation now follows the SDK 1.30.0 source for URL elicitation
  ids and URLs, integer token limits, Base64 content, tool schemas and task
  support metadata, and `file://` roots.
- Corrupt status-specific records fail loudly instead of fabricating empty
  result, error or input payloads.
- The public conformance kit no longer produces false greens for durability,
  missing runner capabilities or hanging stores. Optional `reopen()` exercises
  cross-instance persistence through a complete partial-input round, skips are
  delegated to the runner, operations have finite deadlines, and cleanup
  failures remain visible.
- `WalTaskStore` now uses an explicit 8 MiB task-record default instead of
  inheriting process-wal's 1 MiB event default. Oversized writes surface as
  `TaskEntryTooLargeError` with code `ERR_ENTRY_TOO_LARGE` before mutation, so
  workers can retry completion with a bounded result.

### Changed

- Development, CI, packaging and the lockfile now use pnpm 11.21.0. Dependency
  install scripts are denied by default; only `esbuild` is explicitly allowed.
- `defaultPollIntervalMs: null` now omits the optional wire hint; `undefined`
  continues to select the 1,000 ms default.
- Public documentation links now target the packed English contract instead
  of private planning drafts.
- CAS conflicts are recognized by error name in both the lifecycle and
  conformance kit, so duplicated package installations do not break retries.
- `TaskPatch` now explicitly applies enumerable own string-keyed properties;
  the conformance kit pins that boundary alongside `undefined` deletion.
- Conformance factories are now required to return a fresh store instance per
  check; duplicate creates, pure reads, input bookkeeping and exact sweep
  deletion are checked against the complete persisted state.
- Worker coordination is explicitly process-local; multi-instance hosts need
  request affinity or external coordination for live workers.
- `TaskPatch` now documents `undefined` as deletion for every store.
- Durable mutation execution now lives in an internal `TaskMutator`: terminal
  guards, monotonic timestamps and bounded CAS retries have one owner, while
  `TaskLifecycle` remains responsible for protocol decisions and committed
  worker effects.

[Unreleased]: https://github.com/AndresSaa/mcp-durable-tasks/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/AndresSaa/mcp-durable-tasks/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/AndresSaa/mcp-durable-tasks/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/AndresSaa/mcp-durable-tasks/releases/tag/v0.1.0
