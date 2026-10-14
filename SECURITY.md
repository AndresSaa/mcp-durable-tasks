# Security policy

## Supported versions

| Version     | Supported               |
| ----------- | ----------------------- |
| Pre-release | Yes — latest `0.x` only |

Only the latest npm release receives fixes; there are no backport branches. While the package is `0.x`, a security fix that breaks the documented contract ships as a minor bump with a changelog entry. After `1.0.0` it would be a major.

## Reporting a vulnerability

Report privately through GitHub, never in a public issue or discussion:

**[Open a private advisory](https://github.com/AndresSaa/mcp-durable-tasks/security/advisories/new)**

Only the maintainer can see it. Please include the affected version, which `TaskStore` you used, and the smallest reproduction you can manage. For this package that usually means a sequence of lifecycle calls plus the state the store was left in.

Expect an acknowledgement within a week. A valid report gets a fix timeline, and credit in the advisory and `CHANGELOG.md` unless you ask otherwise. If we cannot fix something, you get the reason.

## What is in scope

This library holds task state for an MCP server and hands it back to whoever presents a task ID. The invariants below (I2, I5, I6, I7) are in [docs/contract.md](docs/contract.md#store-invariants).

- **Guessable or enumerable task IDs (I6).** A task ID works as a bearer token for the stored state: anyone holding it can read the result through `tasks/get`. IDs come from a CSPRNG. An ID derived from a counter, a timestamp or the call's arguments, or any weakening of that generation, is a vulnerability.
- **Any API that enumerates tasks (I7).** The extension has no `tasks/list` on purpose. A code path that leaks the existence or contents of tasks the caller did not create defeats that. `sweep()` returning payloads would be one.
- **Cross-task leakage through `inputRequests` key collisions (I5).** Input keys are unique for the life of a task. A collision that lets a `tasks/update` satisfy a request it was not answering, or routes a response to the wrong task, is in scope.
- **Compare-and-swap being bypassable.** A concurrent `tasks/update` that writes against a stale version without a `ConcurrentUpdateError` can silently discard another caller's write.
- **State surviving a terminal transition or a TTL expiry (I2).** A task that keeps returning results after it expired, or that can leave a terminal state, is a defect.
- **Acknowledged work lost against the documented durability contract.** A durability guarantee that does not hold is a bug whether or not an attacker can reach it.
- **Prototype pollution** that reaches application objects through a stored task payload or an input response.

## What is not in scope

These are documented behaviors. If the docs are unclear, a normal issue is welcome, but they are not handled as security reports.

- **Authorization.** This library does not know who is calling. Whether a caller may create or read a task is decided by the MCP server in front of it. Holding a task ID is sufficient by design.
- **Transport, auth and protocol-version negotiation.** That is the SDK's job.
- **Payload contents.** Results and input responses are stored as given, with no encryption or compression. Anything sensitive in a payload is as exposed as the store you chose.
- **`WalTaskStore` on shared or ephemeral storage.** It inherits [`process-wal`](https://github.com/AndresSaa/process-wal)'s contract: one writer, one process, one disk, and a WAL directory private to the account running the process. Two processes on one directory, or a serverless filesystem, are unsupported configurations, not vulnerabilities. So is data loss after host or power loss under the default durability boundary. Use a store on your own shared database instead; the interface is five methods.
- **Vulnerabilities in development dependencies** that cannot reach a consumer. The tarball carries only `dist/`, `docs/`, `README.md`, `CHANGELOG.md`, `LICENSE` and `package.json`.

## Supply chain

`v0.1.0` was published manually, protected by the maintainer's npm account and 2FA, because the package had to exist before npm allowed a trusted publisher to be configured. It carries no CI provenance.

From `v0.2.0`, releases publish from GitHub Actions with npm [trusted publishing](https://docs.npmjs.com/trusted-publishers) over OIDC and automatic [provenance](https://docs.npmjs.com/generating-provenance-statements). No long-lived npm token exists in this repository. Check provenance with `npm audit signatures`; `0.1.0` is the documented exception.
