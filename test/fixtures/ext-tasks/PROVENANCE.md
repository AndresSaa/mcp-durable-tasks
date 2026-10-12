# Vendored `ext-tasks` schema

These three files are copied verbatim from the extension's own repository, from
the released `2026-07-28` snapshot. They are **not** edited here — if one is
wrong, it is wrong upstream, and the fix is an issue against
`modelcontextprotocol/ext-tasks`.

| File            | Source path                         | Blob SHA                                   |
| --------------- | ----------------------------------- | ------------------------------------------ |
| `schema.json`   | `schema/2026-07-28/schema.json`     | `1d0ec255bbcc5744264be53bba0e09e7eb8a5615` |
| `schema.ts`     | `schema/2026-07-28/schema.ts`       | `b6f6bffc1c19698d75a2ce3b69525ae0c3bfb8b8` |
| `spec.types.ts` | `schema/2026-07-28/spec.types.ts`   | `2d6623aaeabf4f2825af0c5dea56b285c68491ba` |

Repository `main` when they were taken:
`899c1bbc869567670093face3591b39c28ce3219` (2026-10-09). The snapshot directory
was last changed by `0d0a6bd4c258b35caa3c810a1dd506cf105b1501` (2026-08-24,
"lock 2026-07-28 specification and schema"). Fetched 2026-10-12.

`schema/2026-07-28/spec.schema.json` (the MCP base schema as JSON) is not
vendored: `schema.json` already inlines every base definition it references,
and nothing here reads the base schema on its own.

The earlier fixtures tracked `schema/draft/` at `2c1425d` (2026-07-15). That
history is in git; the draft is a moving branch and is not a conformance target.

## Why vendored rather than depended on

The official npm package `@modelcontextprotocol/ext-tasks` (first published
2026-09-17; `0.2.2` checked 2026-10-12) exports `/core`, `/core/v1`,
`/core/v2`, `/client` and `/receiver`, but no schema file. The JSON Schema and
its TypeScript source live only in the extension's GitHub repository.
Vendoring keeps the test suite hermetic and offline, which a network fetch in
CI would not.

`pnpm check:schema` re-fetches the three files from `schema/2026-07-28/` and
fails if any has moved — which, for a snapshot upstream marks immutable, would
be news. Refresh by re-running it with `--write`, and update the SHAs above in
the same commit. The script also reports, for information only, whether the
upstream `draft` has diverged from the snapshot; that report never fails.

## Which file is authoritative

`schema.ts` is. Its header says the TypeScript interfaces are the source of
truth, and that the released snapshot is immutable. It imports its MCP base
types — including the `InputRequests` and `InputResponses` maps — from
`spec.types.ts`, which is why that file is vendored too: without it the
authoritative source is incomplete.

In the earlier `draft` fixture, the generated `schema.json` lost the input
unions and reduced `InputRequest`/`InputResponse` to `anyOf: [{}, {}, {}]`. In
this snapshot they reference concrete `CreateMessageRequest`, `ListRootsRequest`
and `ElicitRequest` definitions and their results (conformance question A8 in
`docs/contract.md`). One narrower spot remains between source and generated
schema: `ElicitResult.content` values are `number` in `spec.types.ts` and
`integer` in `schema.json`. `test/schema-conformance.test.ts` pins it.

The engine's runtime input validation still mirrors
[`@modelcontextprotocol/sdk@1.30.0/src/types.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/1.30.0/src/types.ts).
Where that agrees and diverges with these definitions is tested in
`test/schema-conformance.test.ts`.
