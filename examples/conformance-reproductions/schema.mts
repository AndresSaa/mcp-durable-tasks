/**
 * Re-measurement: in the stable `2026-07-28` schema, the input
 * request/response unions and the result discriminators that the pre-stable
 * `draft` lost are encoded in `schema.json` itself.
 *
 * Recorded as conformance question A8 (and the schema half of A10) in
 * `docs/contract.md`. The original reproduction read the vendored `draft`
 * fixture, where both unions degraded to `anyOf: [{}, {}, {}]` and
 * `resultType` appeared nowhere; that version of this file, and the fixture it
 * read, are kept at the `v0.2.1` tag. Upstream closed the schema issue
 * (modelcontextprotocol/ext-tasks#14) and the fixtures now track the
 * immutable `schema/2026-07-28/` snapshot.
 *
 * **Evidence, not a usage example.** It reads the schema this repository
 * vendors under `test/fixtures/ext-tasks/`, whose provenance file records the
 * exact upstream commit and blob hashes, so the measurement stays reproducible.
 * Validation of engine output against this schema lives in
 * `test/schema-conformance.test.ts`, which has a JSON Schema validator; this
 * script deliberately has no dependency and inspects the definitions directly.
 *
 * Run: `node --experimental-strip-types schema.mts`
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Def = Record<string, unknown>;

const fixtures = new URL("../../test/fixtures/ext-tasks/", import.meta.url);

const schema = JSON.parse(
  readFileSync(new URL("schema.json", fixtures), "utf8"),
) as { $id: string; $defs: Record<string, Def> };
const source = readFileSync(new URL("schema.ts", fixtures), "utf8");
const base = readFileSync(new URL("spec.types.ts", fixtures), "utf8");

const defs = schema.$defs;

console.log(`schema: ${schema.$id}`);
assert.equal(
  schema.$id,
  "https://modelcontextprotocol.io/ext-tasks/2026-07-28/schema.json",
  "this measurement is against the stable snapshot, not the draft",
);

/** Follows a local `$ref` to its definition. */
function deref(node: Def): [string, Def] {
  const ref = node.$ref;
  assert.equal(
    typeof ref,
    "string",
    `expected a $ref, got ${JSON.stringify(node)}`,
  );
  const name = (ref as string).replace("#/$defs/", "");
  const target = defs[name];
  assert.ok(target, `${ref as string} does not resolve`);
  return [name, target];
}

/* -- 1. the input unions are concrete ------------------------------------- */

const unions = {
  InputRequest: ["CreateMessageRequest", "ListRootsRequest", "ElicitRequest"],
  InputResponse: ["CreateMessageResult", "ListRootsResult", "ElicitResult"],
} as const;

console.log("\nunion definitions in the generated schema:");
for (const [union, expected] of Object.entries(unions)) {
  const branches = (defs[union]?.anyOf ?? []) as Def[];
  const names = branches.map((branch) => deref(branch)[0]);
  console.log(`  ${union.padEnd(13)} anyOf ${JSON.stringify(names)}`);
  assert.deepEqual(names, expected, `${union} should reference the MCP types`);
  for (const branch of branches) {
    const [name, target] = deref(branch);
    assert.ok(
      Array.isArray(target.required) && target.required.length > 0,
      `${name} should constrain its shape (the draft's branches were {})`,
    );
  }
}

// Each request branch is discriminated by a constant `method`, so a value
// with any other method — or none — matches no branch.
console.log("\nrequest branches by method:");
for (const branch of defs.InputRequest!.anyOf as Def[]) {
  const [name, target] = deref(branch);
  const properties = target.properties as Record<string, Def>;
  const method = properties.method?.const;
  console.log(
    `  ${name.padEnd(21)} method=${JSON.stringify(method)} required=${JSON.stringify(target.required)}`,
  );
  assert.equal(typeof method, "string", `${name} should pin its method`);
  assert.ok((target.required as string[]).includes("method"));
}

// The task variant uses it: input_required carries a map of those requests.
const inputRequests = (
  defs.InputRequiredTask!.properties as Record<string, Def>
).inputRequests!;
const [mapName, map] = deref(inputRequests);
console.log(
  `\nInputRequiredTask.inputRequests -> ${mapName}, values ${JSON.stringify(map.additionalProperties)}`,
);
assert.deepEqual(map.additionalProperties, { $ref: "#/$defs/InputRequest" });

// What the TypeScript source declares, for comparison. `schema.ts` imports
// the maps from the MCP base types, which declare the union.
const imported = source.match(
  /import type \{[\s\S]*?\} from "\.\/spec\.types\.js";/,
)?.[0];
const declared = base.match(/export type InputRequest =[\s\S]*?;/)?.[0];
console.log("\nschema.ts imports:\n" + imported);
console.log("spec.types.ts declares:\n" + declared);
assert.ok(imported?.includes("InputRequests"));
assert.ok(declared?.includes("CreateMessageRequest"));

/* -- 2. the result discriminators are required ---------------------------- */

const results = {
  CreateTaskResult: "task",
  GetTaskResult: "complete",
  UpdateTaskResult: "complete",
  CancelTaskResult: "complete",
} as const;

/** Collects `resultType` constraints from an `allOf` composition. */
function discriminator(def: Def): { required: boolean; values: unknown[] } {
  let required = false;
  const values: unknown[] = [];
  for (const part of (def.allOf ?? []) as Def[]) {
    const target = part.$ref ? deref(part)[1] : part;
    if ((target.required as string[] | undefined)?.includes("resultType")) {
      required = true;
    }
    const property = (target.properties as Record<string, Def> | undefined)
      ?.resultType;
    if (property && "const" in property) values.push(property.const);
  }
  return { required, values };
}

console.log("\nresultType in the generated schema:");
for (const [name, value] of Object.entries(results)) {
  const found = discriminator(defs[name]!);
  console.log(
    `  ${name.padEnd(17)} required=${found.required} const=${JSON.stringify(found.values)}`,
  );
  assert.ok(found.required, `${name} should require resultType`);
  assert.deepEqual(found.values, [value], `${name} should pin "${value}"`);
}

/* -- 3. the variants are open ---------------------------------------------- */

// The draft closed every task variant with `additionalProperties: false`,
// which made it reject the discriminator the specification requires. The
// snapshot closes nothing; a closed wire is an implementation's own promise.
assert.ok(
  !JSON.stringify(schema).includes('"additionalProperties":false'),
  "the stable schema sets additionalProperties: false nowhere",
);
console.log(
  "\nadditionalProperties: false appears nowhere in the stable schema.",
);

console.log(
  `\nmeasured against ${fileURLToPath(fixtures)} — see PROVENANCE.md for the upstream commit.`,
);
