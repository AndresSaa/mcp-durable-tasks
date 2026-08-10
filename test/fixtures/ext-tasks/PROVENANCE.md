# Vendored `ext-tasks` schema

These two files are copied verbatim from the extension's own repository. They
are **not** edited here — if one is wrong, it is wrong upstream, and the fix is
an issue against `modelcontextprotocol/ext-tasks`.

| File          | Source path                | Blob SHA                                   |
| ------------- | -------------------------- | ------------------------------------------ |
| `schema.json` | `schema/draft/schema.json` | `d6ccaff7e3fb2131b5d752dd8b6f34096e58e976` |
| `schema.ts`   | `schema/draft/schema.ts`   | `2634c47c2b25ac8fafe7fadaa7dd3f3b732c0abc` |

Repository `HEAD` when they were taken: `2c1425d9a288b9b1f489430fe1e00bb392b47e48`
(2026-07-15). Fetched 2026-08-09.

## Why vendored rather than depended on

There is no npm package to depend on. `@modelcontextprotocol/ext-tasks` does
not exist in the registry (checked 2026-08-09), and the schema lives only in
the extension's GitHub repository. Vendoring keeps the test suite hermetic and
offline, which a network fetch in CI would not.

`pnpm check:schema` re-fetches both files and fails if either has moved, so
"the spec changed" arrives as a red build rather than as a surprise months
later. Refresh by re-running it with `--write`, and update the SHAs above in
the same commit.

## Which of the two is authoritative

`schema.ts` is. Its own header says the TypeScript interfaces are the source of
truth and `schema.json` is generated from them via `ts-to-zod`.

That distinction is not academic here, because the generated JSON Schema is
**lossier than its source in one place that matters**. `InputRequest` and
`InputResponse` are declared in `schema.ts` as unions of SDK types
(`CreateMessageRequest | ListRootsRequest | ElicitRequest` and their results),
imported from `@modelcontextprotocol/sdk/types.js`. Those imports do not
resolve during generation, so in `schema.json` they degrade to `anyOf: [{}, {},
{}]` — which accepts literally anything.

A validator built on `schema.json` alone would therefore accept a malformed
input request without complaint. Ours must not: the typed union in `schema.ts`
is what we implement against. This is recorded as an ambiguity in
`docs/contract.md` and belongs in the conformance issue.

The imported union is mirrored from
[`@modelcontextprotocol/sdk@1.30.0/src/types.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/1.30.0/src/types.ts).
Runtime validation tests are checked against those Zod schemas directly, not
against the hand-written TypeScript mirror they are intended to test.
