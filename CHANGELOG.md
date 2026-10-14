# Changelog

All notable changes to this project are documented here, in [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) order.

This package is pre-1.0. Until `1.0.0`, a breaking change is a **minor** bump with a clear entry here. `TaskStore` and `TaskLifecycle` are frozen at `1.0.0`; after that, breaking either is a major version.

## [Unreleased]

## [0.4.0] - 2026-10-15

Closes the known issues of `0.3.0` and the input-round races two further audits found in the fixes. Several entries are breaking, so it is a minor release. No new protocol feature was added.

### Added

- A worker's `handle.signal` is now aborted when its task's TTL elapses, with a `TaskNotFoundError` as the reason. A worker that checks `signal.aborted` to detect cancellation should also check `signal.reason.name`; a cancelled task keeps its `TaskCancelled` reason. Nothing is written and the wire is unchanged; the abort is cooperative, process-local and never happens for `ttlMs: null`.
- `TaskHandle.resumeInput()` lets a restarted worker pick up input a client sent while no worker was running. It returns those answers at most once, or `undefined`, so call it first after a restart; if the process dies after the claim, they are gone. This closes the `0.3.0` known issue "Input responses do not survive a restart" for rounds completed from now on; a log written by `0.3.0` opens unchanged.
- **Breaking for third-party stores:** a `TaskStore` must persist the new record field `unclaimedInputResponses` through `create()`, `update()`, `get()` and reopen. The conformance kit has new checks for it. Both included stores pass unchanged, and code that implements `TaskHandle` itself must add `resumeInput()`.

### Fixed

- A `tasks/update` that completes an older input round no longer resolves a newer round's `requestInput()` with the older answers.
- A reply that completes a round while a restarted worker re-asks with the same, already used keys is no longer lost: `requestInput()` throws `DuplicateInputKeyError` as before, and `resumeInput()` returns the answers.
- A reply whose waiting worker is cancelled just after the reply is written is no longer lost: the answers are kept for `resumeInput()`, unless the task has ended or a new round has opened. If the store fails that write, the answers are lost and its error is thrown from `updateTask()`, or from `requestInput()` if that call was claiming them.
- A worker's signal is no longer aborted with `TaskNotFoundError` while its task is alive because another `TaskLifecycle` on the same store extended or removed the TTL. The lifecycle now reads the task once before aborting. If that read fails or takes more than 5 seconds, the signal and any parked `requestInput()` are left alone and the read is retried, from 1 second up to every 30 seconds, instead of aborting a task that may be alive.
- **Breaking:** `fail()` now requires a JSON-RPC error object: an integer `code`, a string `message` and optional `data`. Anything else throws `TypeError` and nothing is written; before, any object was stored and every `tasks/get` for the task then failed schema validation. An already stored non-conforming error is served as is until the task expires.
- **Breaking (types):** `TaskHandle.fail()` now takes the new `TaskError` type, `{ code: number; message: string; data?: JsonValue }`, so the compiler refuses what the runtime refuses.
- **Breaking:** `requestInput()` now throws `TypeError` when a sampling tool's `inputSchema.$schema` or `outputSchema.$schema` is present but not a string. The exported tool type declares both as `$schema?: string`.
- **Behaviour change:** a sampling tool's `execution` is no longer checked beyond being plain JSON, because the `2026-07-28` `Tool` type does not define it. Nothing accepted before is refused now. In the exported types it is a `JsonValue`, so narrow it before reading `execution.taskSupport`.

## [0.3.0] - 2026-10-13

A hardening release: it closes the findings of an independent audit and aligns input validation with the stable `2026-07-28` revision. Several entries are breaking, so it is a minor release. No new feature was added.

### Fixed

- The conformance kit no longer requires the store's clock to start at `2026-01-01T00:00:00Z`. A store with another clock declares an optional `now()` in `TaskStoreUnderTest`; without it, behavior is unchanged.
- **Breaking:** `ttlMs` and `pollIntervalMs` must be integer milliseconds up to `Number.MAX_SAFE_INTEGER`, as the schema requires. `createTask()`, `progress()` and the `defaultTtlMs` / `defaultPollIntervalMs` options throw `TypeError` otherwise. A stored non-integer hint is served as is until the worker revises it.
- `progress()`, `cancelled()` and `createTask()` throw `TypeError` when `statusMessage` is not a string.
- **Behaviour change:** input validation now accepts three shapes the stable schema allows: URL elicitation without `elicitationId`, a sampling tool whose `outputSchema` is not rooted at `type: "object"`, and a tool result whose `structuredContent` is any JSON value. Narrow `structuredContent` before reading it as an object.
- **Breaking:** a sampling message's `content`, and the `content` of the result that answers it, is limited to text, image, audio, `tool_use` and `tool_result` blocks. A `resource_link` or embedded `resource` there now throws `TypeError`; both stay valid inside a `tool_result`.
- **Breaking:** `sweepIntervalMs` (`TaskLifecycle`) and `compactEvery` (`WalTaskStore`) are validated, and an invalid value throws `TypeError` from the constructor. `sweepIntervalMs` is `null`, `undefined` or an integer from 1 to 2,147,483,647; `compactEvery` is `null`, `undefined` or a safe integer of at least 1.
- `WalTaskStore.compact()` now drops expired tasks from memory, so a clock that steps back no longer makes `get()` return a task that is gone after the next reopen.
- `cancelTask()` on a task with no worker in this process no longer leaks an `AbortController`; it is released when the task's TTL elapses.
- A stored record with an unknown `status` is now reported as corrupt. Every lifecycle method throws the "inconsistent" error and leaves the record unchanged.
- **Breaking:** `requestInput()` throws `TypeError` when a form elicitation's `requestedSchema.$schema` is present but not a string.

### Changed

- **Behaviour change:** the conformance kit has four new checks, so a third-party store that passed before can now fail. An update with `ttlMs: null` must store `null`, an update that sets `status: "failed"` must round-trip its `error`, an update that sets `lastUpdatedAt` must persist it, and a record with every field populated must round-trip. Both included stores pass.
- Documentation now targets the stable `2026-07-28` revision instead of `draft`, and presents this package as the server-side counterpart of `@modelcontextprotocol/ext-tasks/client`. The planned `mcp-durable-tasks/client` task follower is dropped.
- The roadmap is defined: a `notifications/tasks` change emitter first (the engine emits, the host delivers), then a first-party `node:sqlite` store. Both were first planned one minor earlier, before this release took `0.3.0`.
- Conformance questions A1 (missing client capability is `-32021`), A6 (the SDK serves explicit-schema handlers for `tasks/get` and `tasks/cancel` from `@modelcontextprotocol/server` 2.3.0) and A9 (requests for a task are routed by the `Mcp-Name` header) are settled. Worker process affinity is unchanged.
- `examples/crash-recovery/` now requires `@modelcontextprotocol/server` `^2.3.0` and `@modelcontextprotocol/node` `^2.1.1`, and serves all three task methods through explicit-schema handlers with no middleware. `examples/conformance-reproductions/` re-measured A6 and A10 on 2.3.1; the 2.0.0 versions stay at the `v0.2.1` tag.
- The vendored schema and `pnpm check:schema` now track the immutable `schema/2026-07-28/` snapshot, and the tests validate engine output for every task status against it. Ajv is a development dependency only; the main entry point still has no runtime dependencies.

### Known issues

- Input responses do not survive a restart: if the process that owned a worker dies while its task is `input_required`, a client reply sent before a new worker asks again is acknowledged but never reaches a worker. A restarted worker has to start a new round with new keys. Fixed in `0.4.0`, as are the three schema issues this release listed (`fail()` accepting any object, a non-string tool-schema `$schema`, and the `execution.taskSupport` check).

## [0.2.1] - 2026-08-11

Documentation only: republishes the corrected README to npm, which keeps the README bundled with each version. No engine, API or dependency changes.

### Fixed

- The README now names `v0.2.1` as current, scopes crash recovery to confirmed state held by `WalTaskStore`, and documents both verified SDK era-gate workarounds.

### Changed

- The optional client driver is gated on upstream clarity around A6/A10 or demonstrated user need.

## [0.2.0] - 2026-08-11

The first release published over OIDC with a provenance attestation. No engine code changed since `0.1.0`.

### Added

- `examples/crash-recovery/`: a real MCP server whose task outlives its process. One command kills it with `SIGKILL`, restarts it and asserts the finished result. It runs on every pull request.
- `examples/conformance-reproductions/`: reproductions of three upstream behaviors, pinned to `@modelcontextprotocol/*` 2.0.0 and reported as [ext-tasks#14](https://github.com/modelcontextprotocol/ext-tasks/issues/14), [typescript-sdk#2637](https://github.com/modelcontextprotocol/typescript-sdk/issues/2637) and on [typescript-sdk#2598](https://github.com/modelcontextprotocol/typescript-sdk/issues/2598). Each fails when upstream fixes its issue.

### Fixed

- The README banner now resolves on the npm package page.

### Changed

- The SDK compatibility profile lists two verified workarounds for `tasks/get` and `tasks/cancel`: answering in HTTP middleware above the SDK (the better starting point) or renaming at `transport.onmessage`.

## [0.1.0] - 2026-08-10

First public release, followed by a one-time manual npm publication to establish the package; trusted publishing with provenance starts with the next version.

### Added

- The lifecycle engine, in-memory store, typed input round-trip, TTL handling, CAS retries and schema-safe wire projection.
- `WalTaskStore` on `mcp-durable-tasks/wal`: durable across restarts, with an in-memory read index over a write-ahead log. `process-wal` stays an optional peer, so the main entry point has no dependencies.
- The store conformance kit on `mcp-durable-tasks/testing`: `runTaskStoreConformance()` for your own runner and `checkTaskStore()` for a plain report. It has no dependencies and passes against both included stores.
- `isTaskEntryTooLargeError()` and `isConcurrentUpdateError()` guards that work across duplicated packages and separate CJS bundles.
- The vendored `ext-tasks` schema, pinned by blob SHA, and `pnpm check:schema` to detect upstream drift.
- The repository contract, `docs/api.md`, `docs/durability.md` and `docs/internals.md`, all shipped in the package.
- Crash tests with real child processes and `SIGKILL` against the built package, and a fast-check state-machine suite that checks record and wire parity after every operation.

### Fixed

- Protocol results carry their discriminator: `resultType: "task"` on creation and `"complete"` on get, update and cancel.
- Results, errors and input payloads that are not plain JSON are rejected before any state changes, and `-0` is stored as `0`, so memory and WAL replay stay identical.
- A failed automatic WAL compaction no longer makes an already-durable change look rejected. Use `onCompactionError`; a poisoned WAL fails the next store operation explicitly.
- Input waiters register before `input_required` is observable and settle only from committed writes.
- Terminal results and snapshots no longer share mutable references with callers.
- Invalid TTLs and malformed MCP input requests and responses are rejected before they can create an unreadable or unfulfillable task. Validation follows the SDK 1.30.0 source.
- Corrupt status-specific records fail loudly instead of producing empty payloads.
- The conformance kit no longer gives false greens for durability, missing runner capabilities or hanging stores.
- `WalTaskStore` defaults to an 8 MiB task-record limit instead of process-wal's 1 MiB. An oversized write throws `TaskEntryTooLargeError` (`ERR_ENTRY_TOO_LARGE`) before any change, so a worker can retry with a bounded result.

### Changed

- Development, CI and the lockfile use pnpm 11.21.0, with dependency install scripts denied except for `esbuild`.
- `defaultPollIntervalMs: null` omits the optional wire hint; `undefined` still selects the 1,000 ms default.
- Conformance factories must return a fresh store per check.
- `TaskPatch` applies enumerable own string-keyed properties, and `undefined` means deletion in every store.
- CAS conflicts are recognized by error name, so duplicated installs do not break retries.
- Worker coordination is process-local: a multi-instance host needs request affinity for live workers.

[Unreleased]: https://github.com/AndresSaa/mcp-durable-tasks/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/AndresSaa/mcp-durable-tasks/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/AndresSaa/mcp-durable-tasks/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/AndresSaa/mcp-durable-tasks/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/AndresSaa/mcp-durable-tasks/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/AndresSaa/mcp-durable-tasks/releases/tag/v0.1.0
