/**
 * Reproduction: the generated `schema.json` does not preserve the input
 * request/response unions, nor the result discriminators, that its own
 * TypeScript source declares.
 *
 * Reported as conformance questions A8 and A10 in `docs/contract.md`.
 *
 * **Frozen evidence, not a usage example.** It reads the schema this
 * repository vendors under `test/fixtures/ext-tasks/`, whose provenance file
 * records the exact upstream commit and blob hashes it was taken from — so the
 * measurement stays reproducible even after upstream changes.
 *
 * Run: `node --experimental-strip-types schema.mts`
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const fixtures = new URL("../../test/fixtures/ext-tasks/", import.meta.url);

const schema = JSON.parse(
  readFileSync(new URL("schema.json", fixtures), "utf8"),
) as { $defs: Record<string, Record<string, unknown>> };
const source = readFileSync(new URL("schema.ts", fixtures), "utf8");

const defs = schema.$defs;

/* -- 1. the unions collapse to "anything" --------------------------------- */

const unions = ["InputRequest", "InputResponse"] as const;
const unionState = Object.fromEntries(
  unions.map((name) => [name, defs[name]?.anyOf]),
);

console.log("union definitions in the generated schema:");
console.log(JSON.stringify(unionState, null, 2));

for (const name of unions) {
  assert.deepEqual(
    defs[name]?.anyOf,
    [{}, {}, {}],
    `EXPECTED (as of the report): ${name} degrades to three empty schemas`,
  );
}

// An empty JSON Schema accepts every value, so `anyOf` over three of them
// accepts every value. Shown rather than asserted about, because "accepts
// anything" is the whole point.
const nonsense = { definitely: "not an MCP request" };
console.log(
  `\nvalidating ${JSON.stringify(nonsense)} against InputRequest:`,
  "no constraint can reject it — every branch is the empty schema",
);

// What the TypeScript source says instead.
const declared = source.match(/export type InputRequest =[\s\S]*?;/)?.[0];
console.log("\nthe TypeScript source declares:\n" + declared);
assert.ok(
  declared?.includes("CreateMessageRequest"),
  "the source should declare the three concrete request types",
);

/* -- 2. the result discriminators are absent entirely --------------------- */

const results = [
  "CreateTaskResult",
  "GetTaskResult",
  "UpdateTaskResult",
  "CancelTaskResult",
] as const;

console.log("\nresultType in the generated schema:");
for (const name of results) {
  const def = defs[name] ?? {};
  const required = (def.required as string[] | undefined) ?? [];
  const properties = Object.keys((def.properties as object | undefined) ?? {});
  console.log(
    `  ${name.padEnd(18)} required=${JSON.stringify(required)} properties=${JSON.stringify(properties)}`,
  );
  assert.ok(
    !required.includes("resultType") && !properties.includes("resultType"),
    `EXPECTED (as of the report): ${name} does not encode its discriminator`,
  );
}

assert.ok(
  !JSON.stringify(schema).includes("resultType"),
  "EXPECTED (as of the report): resultType appears nowhere in the generated schema",
);

// It is stated only in prose, in the source's JSDoc.
const prose = source
  .split("\n")
  .filter((line) => line.includes("resultType"))
  .map((line) => line.trim());
console.log("\nwhere the requirement does appear in the source:");
for (const line of prose) console.log("  " + line);
assert.ok(
  prose.every((line) => line.startsWith("*")),
  "the requirement lives only in comments, not in a type",
);

console.log(
  `\nreproduced against ${fileURLToPath(fixtures)} — see PROVENANCE.md for the upstream commit.`,
);
