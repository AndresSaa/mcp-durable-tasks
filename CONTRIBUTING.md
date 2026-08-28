# Contributing

Thanks for looking. Please read the next two sections before writing code —
they will save you time if what you have in mind is out of scope, and the
second one is the mistake nearly everyone makes first.

## This is not a to-do manager

MCP uses the word "task" for something specific: a durable handle a server
returns instead of blocking on a long-running operation, which the client then
polls with `tasks/get`. That is the
[Tasks extension](https://tasks.extensions.modelcontextprotocol.io/)
(`io.modelcontextprotocol/tasks`, SEP-2663), and it is the only thing this
package implements.

It does not organize work, keep lists, or track anything for a team. If you
arrived looking for that, the npm packages named `mcp-tasks` and similar are
what you want, and they are unrelated to this one.

## Scope is a constraint, not a starting point

The shipped package implements one role from one extension: the server-side
engine and the `TaskStore` behind it. The roadmap admits only a task follower
that starts after the host already has a task handle and a first-party
`node:sqlite` store for one dedicated local file. Neither is a general MCP
client or a connector family. The small size **is** the product, so some
perfectly reasonable ideas will be declined, and it is not personal:

- **Zero runtime dependencies on the main entry point.** `process-wal` is an
  optional peer of the `/wal` entry point only. Anyone who wants nothing but
  `MemoryTaskStore` must not be made to install it.
- **No community stores in this repository.** Redis, Postgres, D1, Turso,
  libSQL, `better-sqlite3` and any other driver package stay out. A
  first-party store on Node's built-in `node:sqlite` is the only planned
  exception and owns a dedicated local file. SQLite stores using any other
  driver are welcome as their own packages before and after it ships. The
  interface is five methods and
  `mcp-durable-tasks/testing` gives you the test suite before you write a
  line. Publish it and open an issue, and it gets linked from the docs.
- **No framework adapters or workflow-engine bridges.** Not Express, Hono,
  Fastify, Next or Nitro; not LangGraph, Temporal, Inngest or Vercel Workflow.
- **No retries, backoff, dead-letter, priorities, scheduling or cron.** This is
  not a queue.
- **No transport, auth or version negotiation.** That is the SDK's job. The
  planned client-side exception only follows an injected task handle through a
  structural adapter; it does not intercept the SDK or own its compatibility
  seam. A6 workarounds remain in the host.
- **No CLI, dashboard or replay viewer.**
- **No `2025-11-25` task vocabulary.** That revision's tasks are a different,
  retired design.

Bug reports, conformance divergences from the published schema, durability edge
cases, portability fixes, documentation and tests are welcome without
reservation. **A conformance report is the most valuable thing you can open
here** — if this package and the extension's schema disagree, that is a defect
by definition.

## Getting set up

Node.js 22.13 or newer for the pinned pnpm 11 development toolchain. The
published library itself supports Node.js 22 from its first release.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm test               # build, then unit + conformance + crash tests
corepack pnpm lint               # tsc --noEmit, eslint, prettier --check
corepack pnpm coverage
corepack pnpm lint:package       # packs, installs and imports the real tarball
```

## Tests

- Behaviour changes need focused unit tests.
- **Crash and recovery claims need a real child process and a real `SIGKILL`**,
  with explicit sync points — never a sleep, and never a flag that simulates
  the crash. `WalTaskStore` tests use real file I/O in throwaway directories,
  because the filesystem behaviour is the thing under test.
- Any change to a `TaskStore` implementation must keep
  `runTaskStoreConformance()` green against **both** included stores.
- State-machine changes should extend the property-based suite, not only add an
  example: the invariants are about every legal sequence, not the one you
  thought of.
- Packaging changes must pass ESM/CJS and declaration validation.

**Windows is a first-class target.** The maintainer develops on it and CI runs
Node 22/24 across Linux, macOS and Windows. No POSIX-only assumptions about
paths, signals or rename semantics.

Never weaken or delete a test to make a change pass.

## Documentation

- Update `README.md` when positioning, installation, guarantees or limitations
  change; the API reference lives in `docs/api.md`.
- Add an entry to `CHANGELOG.md` under `[Unreleased]` for anything a user would
  notice, written for the person reading the release rather than as a summary
  of your commits. Internal refactors, tests and CI work do not need one.
- **A durability claim may only be documented if a test demonstrates it.**
- Never write copy that positions this as task management. If a paragraph could
  appear in Trello's README, it does not belong here.

## Pull requests

- Branch from an up-to-date `main`. Prefixes: `feat/`, `fix/`, `test/`,
  `chore/`, `docs/`, `refactor/`, kebab-case after the slash.
- **Every pull request targets `main`, and never another pull request.**
- **The title must be a valid
  [Conventional Commit](https://www.conventionalcommits.org/en/v1.0.0/)** —
  pull requests are squash-merged, so the title becomes the commit on `main`
  and CI checks that it parses.
- Keep diffs reviewable, roughly under 400 lines.
- Describe what changed and why, how you tested it — paste real output for
  durability claims — and any effect on the documented invariants.
- Merging needs a green matrix. Do not skip hooks or CI to get a change through.

`AGENTS.md` holds the longer version of all of this, including the reasoning
behind each rule and the constraints that apply to coding agents.

## Reporting things

- **Bugs and conformance divergences:** open an issue.
- **Questions and ideas:** use
  [Discussions](https://github.com/AndresSaa/mcp-durable-tasks/discussions).
- **Security vulnerabilities:** do not open a public issue. Follow
  [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contributions are licensed under the
[MIT License](LICENSE) that covers this project.
