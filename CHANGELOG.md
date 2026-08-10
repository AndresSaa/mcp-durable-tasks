# Changelog

All notable changes to this project are documented here, in
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) order.

This package is pre-1.0. Until `1.0.0`, a breaking change is a **minor** bump
with a clear entry here — normal pre-1.0 semver. `TaskStore` and
`TaskLifecycle` become a frozen contract at `1.0.0`, and from then on breaking
either is a major version.

## [Unreleased]

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

[Unreleased]: https://github.com/AndresSaa/mcp-durable-tasks/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/AndresSaa/mcp-durable-tasks/releases/tag/v0.1.0
