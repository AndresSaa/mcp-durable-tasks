# AGENTS.md — mcp-durable-tasks

Guidance for coding agents (and humans) working in this repository. Read this
before changing anything.

## What this is

The server-side engine of the MCP Tasks extension (`io.modelcontextprotocol/tasks`,
SEP-2663): state machine, TTL, polling hints, and the `inputRequests` round-trip,
behind a small `TaskStore` interface with two included implementations
(`MemoryTaskStore`, `WalTaskStore` on top of `process-wal`). Nothing else — no
generic queue, no agent runtime, no package family.

**This is not a to-do manager**, and that is not a throwaway disclaimer — see
"Naming and positioning" below before writing a single line of copy.

The live repository contract is [`docs/contract.md`](./docs/contract.md): scope,
state model, invariants, conformance decisions and open extension questions.
[`docs/api.md`](./docs/api.md) owns signatures,
[`docs/durability.md`](./docs/durability.md) owns persistence guarantees, and
[`docs/EXECUTION-PLAN.md`](./docs/EXECUTION-PLAN.md) is the operational task
breakdown. Personal program strategy and the private implementation draft are
intentionally not part of the public repository.

## What Spike 0 settled, and what it means for the code

Spike 0 is resolved; the measurement and its environment are in
`docs/contract.md#typescript-sdk-v2-compatibility`. Code is unblocked. The
one-paragraph version, because it shapes the package:

On a 2026-07-28 SDK v2 server, the era gate answers `-32601` to `tasks/get`
and `tasks/cancel` before any handler — including `fallbackRequestHandler` —
is consulted, because both names belong to the retired 2025-11-25 registry.
`tasks/update` is registrable as an ordinary custom method, because SEP-2663
introduced it and no era claims the name. Two host-level escapes are verified:
answer the HTTP requests in middleware before `createMcpHandler`, as the
crash-recovery example does, or rename them below `Protocol`, at the
`transport.onmessage` seam.

So the engine stays pure state. The package does **not** ship a compatibility
seam; hosts choose their own narrow middleware or transport workaround. A6 may
remove that host workaround upstream, but it does not create a package feature
by itself. The planned `/client` follower starts after a task handle and never
owns this seam, transport, authentication or version negotiation. See
`docs/contract.md#typescript-sdk-v2-compatibility`.

## Context you must not work from memory on

The Tasks extension (`2026-07-28`) postdates most models' training data. Before
writing code, docs, or an issue that depends on its behavior, read the sources
listed in `docs/contract.md#scope-and-authority` — do not guess field names,
method shapes, or SDK behavior from recall. This applies to the SDK version
actually installed, too: check its docs/source before assuming an API has not
changed.

## Commands

```sh
pnpm build         # tsup — dual CJS/ESM + .d.ts into dist/, three entry points
pnpm test          # build, then vitest run — unit + conformance + crash tests
pnpm test:watch    # vitest
pnpm coverage      # vitest run --coverage — local gate, no hosted service
pnpm lint          # tsc --noEmit && eslint . && prettier . --check
pnpm lint:package  # publint --strict && attw && smoke:package
```

Three things about the layout that are decisions, not accidents:

- **`attw` runs with `--profile node16`.** The legacy `node10` resolution mode
  cannot see `exports` subpaths at all, so `/wal` and `/testing` fail it by
  construction. Supporting it would mean shipping proxy directories — repo
  surface for a resolution mode no version of Node this package supports
  (`engines: >=22`) still uses. The node16 and bundler profiles are not
  relaxed, and `publint` still runs `--strict`.
- **`smoke:package` installs the packed tarball into a workspace with no
  `process-wal`,** then imports `.` and `/testing` by name in both ESM and CJS.
  That absence is the assertion: it is what proves `MemoryTaskStore` costs no
  dependencies. `/wal` is deliberately excluded — it is the entry point allowed
  to need the peer, so loading it there would prove the opposite.
- **The "no `node:*`" boundary is an eslint rule, not a tsconfig.** `tsc` has
  one `types` setting for the whole project, so it cannot say "these files may
  touch Node built-ins while those may not". `eslint.config.js` restricts
  `node:*` imports in `src/index.ts` and `src/testing.ts` and leaves
  `src/wal.ts` alone.

No `pnpm bench` yet — process-wal already benchmarks the storage layer this
package builds on; add one here only when a quantitative claim about the
engine's own overhead needs backing.

There is no `pnpm release`. A release is a merged version-bump PR followed by a
`vX.Y.Z` tag push. `.github/workflows/release.yml` always creates the GitHub
Release. `v0.1.0` is published to npm manually after its tag establishes the
reviewed source release. That creates the registry package needed to configure
trusted publishing; `v0.2.0` and later tags publish over OIDC when the
`NPM_TRUSTED_PUBLISHING=enabled` repository variable is present
(`docs/contract.md#version-contract`, `docs/RELEASE.md`).

## Cross-agent scratch space (`.ai/`)

Same convention as process-wal: gitignored, `pr-audits/` (dated) + `temp/`
(disposable), never authoritative. A finding that only exists in `.ai/` is lost
the moment the directory is cleaned. Spike 0's finding belongs in
`docs/contract.md`, not `.ai/`, or it did not happen.

## Choosing a model, and when to delegate

Not every task here deserves the same model, and a subagent is not free — it
starts cold and re-derives context the session already holds. Two decisions,
in this order.

**Delegate to a subagent only when the work is genuinely separable:** a
read-only search through a codebase not already in context (the SDK's
dispatcher, the Inspector's transport layer), or a self-contained
investigation whose product is a paragraph rather than a diff. Anything that
has to hold this repo's invariants in mind _while editing_ stays inline — a
subagent that first has to be briefed on
`docs/contract.md#store-invariants` costs more than doing the work.

**Pick the tier from what a wrong answer costs, not from how long the task
looks.**

| Tier         | Use it for                                                                                                                                                                                                         | Claude |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| Small / fast | Locating a symbol, listing files, reading a page and reporting what it says, mechanical renames, formatting                                                                                                        | Haiku  |
| Mid          | Tests that mirror an existing pattern, changelog entries, doc prose from already-settled decisions, routine dependency bumps                                                                                       | Sonnet |
| Frontier     | The state machine; anything touching invariants I1–I8; crash tests; the `inputRequests` round-trip; CAS semantics; public API shape; spec-ambiguity rulings destined for `docs/contract.md`; the conformance issue | Opus   |

The frontier row is not a preference. A wrong ruling on a spec ambiguity ships
straight into the issue this project exists to send, and a subtle
state-machine bug is precisely the defect class the package claims to prevent.
Cheap inference is the wrong economy there.

On another provider, map by capability tier rather than by model name — the
rows describe the decision; the last column is one vendor's answer to it.

## Documentation tracks the code, in the same change

`docs/*.md` and `README.md` are not written at the end. A phase is not finished
until they describe what the code actually does. This has already gone wrong
once: an early draft told readers to checkpoint a task at terminal status after
the code had established that doing so erases the result on next open. A
contract that contradicts the implementation is worse than no contract.

So, every change:

- **`docs/contract.md` is the repository contract.** If a change alters scope,
  an invariant, a wire shape or a conformance decision, it lands there in the
  same commit. Public signatures belong in `docs/api.md`; stale signatures are
  a defect, not cosmetic lag.
- **`README.md` states what is true today**, including what is not built yet.
  It is the first thing anyone reads, and the two constraints it leads with —
  single-process `WalTaskStore` and worker process affinity — are load-bearing.
- **`CHANGELOG.md`** gets an entry under `[Unreleased]` for anything a consumer
  would notice.
- **`docs/EXECUTION-PLAN.md`** records what a phase settled, especially the
  decisions that contradict what the plan assumed.

When a document turns out to be wrong, fix it and say so plainly in the commit
body. Two of this package's better design decisions came from correcting the
contract; that only works if the correction is written down.

## Stop and ask for an audit when the change is large

An independent audit of the engine found ten real defects, six of which lost or
corrupted state and none of which the test suite caught. That is the expected
yield, not an anomaly — so it is worth doing again rather than trusting a clean
local run.

**Request an audit before starting the next phase whenever the last one added
substantial new behavior**, and always before a version tag. Do not treat a
green suite as a substitute: every one of those ten findings was present while
all tests passed.

`.ai/AUDIT-BRIEF.md` is the brief to hand the auditing agent; keep it current
as the invariants and the known-settled decisions move. When findings come
back, **verify each one against the code before acting on it** — write the
failing test first. In the last round, one finding was already fixed and my
reproduction was wrong, and four others failed for reasons unrelated to the
claim. An auditor is a strong signal, not an authority.

## Proposing a change to `process-wal`

The [non-goals](./docs/contract.md#non-goals) forbid modifying `process-wal`,
and that stands: it is a
published, stable 1.x package with its own contract, and this project is a
consumer. But _proposing_ an upstream change is legitimate when this package
hits a genuine gap, and the route is an issue on that repository — never a
local edit, never a fork, never a vendored copy.

The bar is high on purpose. Before proposing anything, check that the need is
not actually on this side: the one time it looked like `process-wal` needed a
new primitive, the real defect was that `WalTaskStore` never exposed
`maxEntryBytes`, so a task result over 1 MiB failed `complete()` and lost the
work. Write the workaround first; if it is small and crash-safe, there is no
proposal to make.

## Naming and positioning — read before writing any copy

- **npm name is `mcp-durable-tasks`.** Fallback `@craftender/mcp-durable-tasks`
  if a publish dry-run collides. **Never `mcp-ext-tasks`** — that name belongs
  to a possible future official package from the spec's own maintainers, and
  squatting it occupies their natural namespace
  (`docs/contract.md#non-goals`).
- _*The npm "mcp task*" namespace is entirely to-do-list managers._* None of
  them relate to SEP-2663. "Durable" is the word that separates this package
  from that namespace, and it is the spec's own vocabulary (_durable task
  handle_) — it goes in the name, the description, and the first line of the
  README.
- **Never write copy that sounds like task management.** No "organize," "track,"
  "to-do list," "team workflow." If a paragraph could appear in Trello's
  README, delete it.
- **`mcp-` as an npm prefix reads as "server you add to your `mcp.json`."**
  This is a library you import. The README's first sentence disambiguates this
  explicitly, every time it's touched.

## Non-negotiable constraints

- **Zero runtime dependencies on the main entry point.** `process-wal` is a
  peer + optional dependency of the `/wal` entry point only — whoever wants
  only `MemoryTaskStore` must not be forced to install it.
- **No native binaries, no build step outside `tsc`/`tsup`.**
- **Node.js 22+.** The engine and `MemoryTaskStore` must run in web-standard
  runtimes without `node:fs`.
- **Public API is provisional until the open conformance questions are closed
  and `v1.0.0` ships** (`docs/contract.md#version-contract`). This is the
  opposite of process-wal's posture, deliberately: process-wal's API has been
  closed since 1.x; this one has not shipped a 1.0 yet. Once `TaskStore` and
  `TaskLifecycle` are frozen, this section gets rewritten to match
  process-wal's "closed API surface" language.
- **Read-only `tasks/get`.** Never mutate state there, not even
  `lastUpdatedAt` (I3).
- **No enumeration API, ever** (I7). `sweep()` is internal and never returns
  payloads.
- **Vitest. CI on Linux/macOS/Windows, Node 22 and 24.**
- **After the first manual registry bootstrap, provenance-attested publishing
  over OIDC. No tokens in the repo.**
- **Cover error paths, not just the happy path** — especially the real-process
  crash tests and the property-based state-machine suite described in
  `docs/contract.md#verification`.

## Prohibited without prior discussion

Everything in [`docs/contract.md#non-goals`](./docs/contract.md#non-goals) — a
second package or monorepo, any framework adapter or workflow-engine bridge, a
community store (Redis/Postgres/D1/libSQL/Turso/`better-sqlite3`) inside this
repo, a generic MCP client or SDK compatibility layer, `2025-11-25` task
vocabulary, a CLI or dashboard, retries/backoff/scheduling, touching
`process-wal` itself, transport/auth/version-negotiation (that's the SDK's
job), or `mcp-ext-tasks` as a name. The preferred sequence is the narrow
task-client follower in `v0.3.0`, then the first-party `node:sqlite` store in
`v0.4.0`; either starts only through its readiness gate in the execution plan.
Changing that order requires a prior contract-only decision, never an implicit
implementation choice. Do not widen either exception. If you're about to
propose one of these, stop and ask instead of resolving it yourself.

## Spec ambiguities — how they get documented

`docs/contract.md#extension-conformance-questions` tracks open ambiguities in
the extension itself. When implementation forces a decision before the spec
answers it:

1. Pick the reading that matches the spec's stated intent most closely; state
   the reasoning in the PR.
2. Add or update the entry in `docs/contract.md` — it also feeds the issue to
   `modelcontextprotocol/ext-tasks`, so write it as a
   conformance question, not an implementation note.
3. Never let a spec-ambiguity workaround live only in code comments — it needs
   to be findable from the contract before it needs to be found in `git blame`.

## Versioning and changelog — pre-1.0, hand-written

- `CHANGELOG.md`, Keep a Changelog format, `[Unreleased]` section, same as
  process-wal.
- Unlike process-wal (stable at 1.x), this package starts at `0.1.0`. Per the
  [version contract](./docs/contract.md#version-contract): `0.1.0` (engine +
  both stores + conformance kit + crash tests, first manual npm publication) →
  `0.2.0` (crash-test demo, first OIDC/provenance publication) → preferred
  `0.3.0` (narrow task-client follower, gated by a fresh A6/A10 decision) →
  preferred `0.4.0` (first-party `node:sqlite` store; not a SQL connector
  family) → `1.0.0` once the open conformance questions are closed and
  `TaskStore`/`TaskLifecycle` are frozen. If the client remains blocked, the
  version contract permits a documented pre-worktree reassignment; never infer
  one from this summary.
- Before `1.0.0`, a breaking change is a minor bump with a clear changelog
  entry, not a major — normal pre-1.0 semver. This inverts process-wal's
  "any breaking change is a major" rule, which only applies to a package that
  has already shipped 1.0.

## GitHub workflow

Same as process-wal, adopted verbatim — see its `AGENTS.md` for the reasoning
behind each rule:

- `main` protected, one branch per change, prefixes `feat/` `fix/` `test/`
  `chore/` `docs/` `refactor/`, rebase (never merge) onto `main`.
- Conventional Commits 1.0.0 for commit subjects and PR titles (squash-merged,
  title becomes the commit on `main`); `!` + `BREAKING CHANGE:` footer for
  breaking changes.
- **No AI attribution, ever.** No `Co-Authored-By: Claude …`, no "Generated
  with Claude Code," in commits, PR titles/bodies, `CHANGELOG.md`, comments, or
  release notes — including tool defaults that inject them. Applies to every
  agent and tool in this repository, no exceptions.
- Every PR targets `main`, never another PR; squash-merge only; green matrix
  required (Linux/macOS/Windows × Node 22/24, plus a non-blocking Node Current
  leg); never skip hooks or CI.

## Testing notes

- No filesystem mocking in `WalTaskStore` tests — same argument as
  process-wal: the behavior under test is the real behavior.
- Crash tests use a real child process and real `SIGKILL`, with explicit sync
  points, never sleeps.
- The conformance kit (`mcp-durable-tasks/testing`) must pass against both
  included stores before it ships — it is the product, not an internal helper.
- Windows is a first-class target, same as process-wal — no POSIX-only
  assumptions.

## Open items this file does not answer

Protocol ambiguities live in
[`docs/contract.md`](./docs/contract.md#extension-conformance-questions), and
release/account operations live in [`docs/RELEASE.md`](./docs/RELEASE.md).
Do not resolve either category from assumptions in this file.
