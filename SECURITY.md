# Security policy

## Supported versions

| Version     | Supported               |
| ----------- | ----------------------- |
| Pre-release | Yes — latest `0.x` only |

Nothing is published to npm yet; the first release is `0.2.0`. This is a
single-maintainer package with no backport branches: fixes land on the latest
release. While the package is `0.x`, a security fix that has to break the
documented contract ships as a minor bump with a clear changelog entry — normal
pre-1.0 semver. After `1.0.0` it would be a major version.

## Reporting a vulnerability

Report privately through GitHub — never in a public issue or discussion:

**[Open a private advisory](https://github.com/AndresSaa/mcp-durable-tasks/security/advisories/new)**

That form is only visible to the maintainer. Please include the affected
version, which `TaskStore` was in use, and the smallest reproduction you can
manage — for this package that usually means a sequence of lifecycle calls plus
the state the store was left in.

Expect an acknowledgement within a week. A valid report gets the fix timeline
with it, and credit in the advisory and `CHANGELOG.md` unless you ask
otherwise. A report this package cannot fix gets a reason rather than silence.

## What is in scope

This library holds task state on behalf of an MCP server and hands it back to
whoever presents a task ID. Most of its threat model follows from that one
sentence. The invariants referenced below are specified in
[docs/contract.md](docs/contract.md#store-invariants).

- **Task IDs that are guessable or enumerable (I6).** A task ID is effectively
  a bearer token for the stored state: anyone holding it can read the task's
  result through `tasks/get`. IDs are generated from a CSPRNG for exactly this
  reason. An ID derived from a counter, a timestamp, or the call's arguments —
  or any weakening of that generation — is a vulnerability, not a style
  question.
- **Any API that enumerates tasks (I7).** The extension deliberately has no
  `tasks/list`, so one caller's tasks are not discoverable by another. A code
  path that leaks the existence or contents of tasks the caller did not create
  defeats that, and `sweep()` returning payloads would be one.
- **Cross-task leakage through `inputRequests` key collisions (I5).** Input
  keys are unique for the lifetime of a task. A collision that let a
  `tasks/update` satisfy a request it was not answering — or route a response
  to the wrong task — is in scope.
- **Compare-and-swap being bypassable.** A concurrent `tasks/update` that
  lands a write against a stale version without a `ConcurrentUpdateError`
  can silently discard another caller's write.
- **State surviving a terminal transition or a TTL expiry.** A task that keeps
  returning results after it expired, or that can be moved out of a terminal
  state (I2), is a real defect.
- **Acknowledged work lost against the documented durability contract.** A
  durability guarantee that does not hold is a bug whether or not an attacker
  can reach it.
- **Prototype pollution** reaching application objects through a stored task
  payload or an input response.

## What is not in scope

These are documented behaviours. Reporting them as a normal issue is welcome if
the documentation is unclear, but they will not be handled as security reports:

- **Authorization.** This library does not know who is calling. Deciding
  whether a caller may create or read a task belongs to the MCP server in front
  of it, and the extension binds tasks to the request that created them at that
  layer. Possession of a task ID is treated as sufficient by design.
- **Transport, auth and protocol-version negotiation.** Not implemented here —
  that is the SDK's job.
- **Payload contents.** Task results and input responses are stored as given.
  There is no encryption, compression or configurable serialization, by
  design; anything sensitive in a payload is as exposed as the store you chose.
- **`WalTaskStore` on shared or ephemeral storage.** It inherits
  [`process-wal`](https://github.com/AndresSaa/process-wal)'s contract: single
  writer, one process, one disk, and a WAL directory that must be private to
  the account running the process. Two processes writing the same directory, or
  a serverless filesystem, are unsupported configurations rather than
  vulnerabilities — as is data loss after host or power loss under the default
  durability boundary. Use a store built on your own shared database instead;
  the interface is five methods.
- **Vulnerabilities in development dependencies** that cannot reach a consumer
  of the published package. The tarball carries only `dist/`, `docs/`,
  `README.md`, `CHANGELOG.md`, `LICENSE` and `package.json` — no scripts, no
  configuration and no tests.

## Supply chain

`v0.1.0` is not published to npm. The first registry release, `v0.2.0`, is a
manual bootstrap publication protected by the maintainer's npm account and 2FA;
it cannot carry CI provenance. The package has to exist before npm allows its
trusted publisher to be configured.

After that bootstrap, releases publish from GitHub Actions using npm
[trusted publishing](https://docs.npmjs.com/trusted-publishers) over OIDC, with
[provenance](https://docs.npmjs.com/generating-provenance-statements) attested
automatically. No long-lived npm token exists in this repository. Provenance on
those later versions can be checked with `npm audit signatures`; the initial
`0.2.0` version is the documented exception.
