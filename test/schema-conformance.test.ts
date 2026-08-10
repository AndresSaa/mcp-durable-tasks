import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// docs/contract.md records what the extension's schema actually says, field by
// field, because several of those facts contradict what the specification
// assumed before anyone read it. Those facts are now load-bearing: the engine
// is being designed against them.
//
// This suite pins them to the vendored copy. It is not testing the schema — the
// schema is upstream's — it is testing that our reading of it is still true. If
// `pnpm check:schema --write` pulls in a new revision, whatever changed
// shows up here as a named failure instead of as a silent divergence between
// the code and the document that justifies it.

const schema = JSON.parse(
  readFileSync(
    new URL("./fixtures/ext-tasks/schema.json", import.meta.url),
    "utf8",
  ),
) as {
  $defs: Record<
    string,
    {
      required?: string[];
      properties?: Record<string, unknown>;
      additionalProperties?: unknown;
      anyOf?: unknown[];
    }
  >;
};

const defs = schema.$defs;

const BASE_REQUIRED = [
  "taskId",
  "status",
  "createdAt",
  "lastUpdatedAt",
  "ttlMs",
];

describe("the base Task shape", () => {
  it("requires exactly the five fields in the public contract", () => {
    expect(defs.Task.required).toEqual(BASE_REQUIRED);
  });

  // The engine may omit this. An earlier private draft had it required
  // in TaskRecord, which would have produced a non-conforming wire shape.
  it("leaves pollIntervalMs optional", () => {
    expect(defs.Task.properties).toHaveProperty("pollIntervalMs");
    expect(defs.Task.required).not.toContain("pollIntervalMs");
  });

  it("requires ttlMs as a field even though its value may be null", () => {
    expect(defs.Task.required).toContain("ttlMs");
    expect(defs.Task.properties?.ttlMs).toEqual({
      anyOf: [{ type: "number" }, { type: "null" }],
    });
  });

  it("leaves statusMessage optional for every status", () => {
    expect(defs.Task.required).not.toContain("statusMessage");
  });
});

describe("the wire shape is closed", () => {
  // This is why TaskRecord (what a store keeps, including the CAS `version`)
  // and DetailedTask (what goes over the wire) have to be two types. Serialising
  // an internal field would produce a task the schema rejects.
  it.each([
    "Task",
    "WorkingTask",
    "InputRequiredTask",
    "CompletedTask",
    "FailedTask",
    "CancelledTask",
  ])("%s forbids additional properties", (name) => {
    expect(defs[name].additionalProperties).toBe(false);
  });
});

describe("status-specific fields", () => {
  it("requires inputRequests only on input_required", () => {
    expect(defs.InputRequiredTask.required).toContain("inputRequests");
    for (const other of [
      "WorkingTask",
      "CompletedTask",
      "FailedTask",
      "CancelledTask",
    ]) {
      expect(defs[other].required).not.toContain("inputRequests");
    }
  });

  it("requires result only on completed, and types it as an object", () => {
    expect(defs.CompletedTask.required).toContain("result");
    expect(defs.CompletedTask.properties?.result).toMatchObject({
      type: "object",
    });
    for (const other of [
      "WorkingTask",
      "InputRequiredTask",
      "FailedTask",
      "CancelledTask",
    ]) {
      expect(defs[other].required).not.toContain("result");
    }
  });

  it("requires error only on failed, and types it as an object", () => {
    expect(defs.FailedTask.required).toContain("error");
    expect(defs.FailedTask.properties?.error).toMatchObject({ type: "object" });
  });

  it("gives working and cancelled no extra fields beyond the base", () => {
    expect(defs.WorkingTask.required).toEqual(BASE_REQUIRED);
    expect(defs.CancelledTask.required).toEqual(BASE_REQUIRED);
  });
});

describe("there is still no enumeration API (I7)", () => {
  it("defines no tasks/list request or result", () => {
    const names = Object.keys(defs).join(" ");
    expect(names).not.toMatch(/ListTasks/);
  });
});

describe("the generated JSON Schema is lossier than its TypeScript source", () => {
  // Conformance question A8, and one of the two strongest issue findings.
  // InputRequest is declared upstream as
  //   CreateMessageRequest | ListRootsRequest | ElicitRequest
  // but those imports do not resolve during generation, so the JSON Schema
  // accepts anything. If this ever stops being true, upstream fixed it — and
  // conformance question A8 should be closed rather than raised.
  it("still degrades InputRequest to an unconstrained anyOf", () => {
    expect(defs.InputRequest.anyOf).toEqual([{}, {}, {}]);
  });

  it("still degrades InputResponse the same way", () => {
    expect(defs.InputResponse.anyOf).toEqual([{}, {}, {}]);
  });
});

describe("the TypeScript source, which is authoritative", () => {
  const source = readFileSync(
    new URL("./fixtures/ext-tasks/schema.ts", import.meta.url),
    "utf8",
  );

  it("types input requests as the three server-to-client MCP requests", () => {
    expect(source).toMatch(
      /export type InputRequest =\s*\|?\s*CreateMessageRequest\s*\|\s*ListRootsRequest\s*\|\s*ElicitRequest/,
    );
  });

  it("declares itself the source of truth that schema.json is generated from", () => {
    expect(source).toContain("source of truth");
    expect(source).toContain("ts-to-zod");
  });
});
