import { readFileSync } from "node:fs";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  MemoryTaskStore,
  TaskLifecycle,
  type InputRequest,
  type TaskHandle,
  type TaskRecord,
} from "../src/index.js";
import { assertInputResponse, isInputRequest } from "../src/input.js";

// Two different things are tested here, and they must not be confused.
//
// 1. Our reading of the official `2026-07-28` schema, pinned to the vendored
//    copy (test/fixtures/ext-tasks/PROVENANCE.md). This is not testing the
//    schema — it is upstream's — but that docs/contract.md still describes
//    it correctly. If `pnpm check:schema --write` pulls in a new revision,
//    whatever changed shows up here as a named failure.
//
// 2. What the engine actually emits, validated against that schema with a
//    real JSON Schema 2020-12 validator, plus the guarantee that is ours and
//    not the schema's: the wire projection is closed. The stable schema sets
//    no `additionalProperties: false` anywhere, so it would accept a leaked
//    `version`; only this package's allow-list keeps it out.

const fixture = (name: string) =>
  readFileSync(
    new URL(`./fixtures/ext-tasks/${name}`, import.meta.url),
    "utf8",
  );

const schema = JSON.parse(fixture("schema.json")) as {
  $id: string;
  $schema: string;
  $defs: Record<string, Record<string, unknown>>;
};
const defs = schema.$defs;

// Strict, so an unknown keyword fails loudly instead of being ignored.
// Two relaxations, both forced by the schema as published:
// - `allowUnionTypes`: it uses `type: ["string", "integer", "boolean"]`.
// - `uri` and `byte` are declared as known formats without validating them.
//   In 2020-12, `format` is an annotation unless a validator opts in, and the
//   engine enforces both itself (URL parsing, Base64); the cross-check below
//   pins exactly where that makes the engine stricter than the schema.
const ajv = new Ajv2020({
  strict: true,
  allowUnionTypes: true,
  allErrors: true,
  formats: { uri: true, byte: true },
});
ajv.addSchema(schema);

const validators = new Map<string, ValidateFunction>();
function errorsAgainst(def: string, value: unknown): string[] {
  let validate = validators.get(def);
  if (validate === undefined) {
    validate = ajv.getSchema(`${schema.$id}#/$defs/${def}`);
    if (validate === undefined) throw new Error(`no $defs/${def}`);
    validators.set(def, validate);
  }
  return validate(value)
    ? []
    : (validate.errors ?? []).map(
        (error) => `${error.instancePath || "/"} ${error.message ?? ""}`,
      );
}

const conforms = (def: string, value: unknown) =>
  expect(errorsAgainst(def, value), def).toEqual([]);
const violates = (def: string, value: unknown) =>
  expect(errorsAgainst(def, value), def).not.toEqual([]);

/* -- shared engine fixtures --------------------------------------------- */

const TEXT = { type: "text" as const, text: "hello" };
const RESOURCE_LINK = {
  type: "resource_link" as const,
  uri: "file:///x",
  name: "x",
};
const EMBEDDED_RESOURCE = {
  type: "resource" as const,
  resource: { uri: "file:///x", text: "x" },
};
const SAMPLING: InputRequest = {
  method: "sampling/createMessage",
  params: { messages: [{ role: "user", content: TEXT }], maxTokens: 64 },
};
const ROOTS: InputRequest = { method: "roots/list" };
const ELICIT: InputRequest = {
  method: "elicitation/create",
  params: {
    message: "Continue?",
    requestedSchema: {
      type: "object",
      properties: { confirm: { type: "boolean" } },
    },
  },
};

function engine(options: { defaultPollIntervalMs?: number | null } = {}) {
  return new TaskLifecycle({
    store: new MemoryTaskStore(),
    sweepIntervalMs: null,
    ...options,
  });
}

async function untilParked(lifecycle: TaskLifecycle, taskId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const view = await lifecycle.getTask(taskId);
    if (view.status === "input_required") return view;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`task ${taskId} never reached input_required`);
}

const VARIANT = {
  working: "WorkingTask",
  input_required: "InputRequiredTask",
  completed: "CompletedTask",
  failed: "FailedTask",
  cancelled: "CancelledTask",
} as const;

/** Every definition a `tasks/get` result has to satisfy at once. */
function conformsAsGetResult(view: { status: keyof typeof VARIANT }) {
  conforms("GetTaskResult", view);
  conforms("DetailedTask", view);
  conforms(VARIANT[view.status], view);
}

/* == 1. Our reading of the stable schema ================================= */

const BASE_REQUIRED = [
  "taskId",
  "status",
  "createdAt",
  "lastUpdatedAt",
  "ttlMs",
];

describe("the vendored schema is the stable 2026-07-28 snapshot", () => {
  it("identifies itself as that revision, in JSON Schema 2020-12", () => {
    expect(schema.$id).toBe(
      "https://modelcontextprotocol.io/ext-tasks/2026-07-28/schema.json",
    );
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
  });

  it("compiles under a strict 2020-12 validator", () => {
    // Every definition, not only the ones the engine touches, so a malformed
    // upstream refresh fails here rather than in whichever test reaches it.
    for (const name of Object.keys(defs)) {
      expect(ajv.getSchema(`${schema.$id}#/$defs/${name}`), name).toBeTypeOf(
        "function",
      );
    }
  });
});

describe("the base Task shape", () => {
  it("requires exactly the five fields in the public contract", () => {
    expect(defs.Task!.required).toEqual(BASE_REQUIRED);
  });

  // The engine may omit this. An earlier private draft had it required
  // in TaskRecord, which would have produced a non-conforming wire shape.
  it("leaves pollIntervalMs optional, and types it as an integer", () => {
    expect(defs.Task!.required).not.toContain("pollIntervalMs");
    expect(
      (defs.Task!.properties as Record<string, unknown>).pollIntervalMs,
    ).toMatchObject({ type: "integer" });
  });

  // The pre-stable draft typed this as `number`; the snapshot narrows it to
  // integer milliseconds, matching the prose in schema.ts.
  it("requires ttlMs as a field, typed as an integer or null", () => {
    expect(defs.Task!.required).toContain("ttlMs");
    expect((defs.Task!.properties as Record<string, unknown>).ttlMs).toEqual({
      anyOf: [
        {
          type: "integer",
          minimum: -Number.MAX_SAFE_INTEGER,
          maximum: Number.MAX_SAFE_INTEGER,
        },
        { type: "null" },
      ],
    });
  });

  it("leaves statusMessage optional for every status", () => {
    for (const variant of ["Task", ...Object.values(VARIANT)]) {
      expect(defs[variant]!.required, variant).not.toContain("statusMessage");
    }
  });
});

describe("the schema is open; closing the wire is this package's job", () => {
  // Pinned because docs/contract.md depends on it: if upstream ever closes the
  // variants, the closed-wire tests below become schema-checked as well, and
  // the contract's wording should change with it.
  it("sets additionalProperties: false nowhere", () => {
    expect(JSON.stringify(schema)).not.toContain(
      '"additionalProperties":false',
    );
  });

  it("therefore accepts a tasks/get result carrying internal fields", () => {
    conforms("GetTaskResult", {
      resultType: "complete",
      taskId: "t",
      status: "working",
      createdAt: "2026-07-28T00:00:00.000Z",
      lastUpdatedAt: "2026-07-28T00:00:00.000Z",
      ttlMs: null,
      version: 7,
      usedInputKeys: ["a"],
    });
  });
});

describe("status-specific fields", () => {
  it("requires inputRequests only on input_required", () => {
    expect(defs.InputRequiredTask!.required).toContain("inputRequests");
    for (const other of [
      "WorkingTask",
      "CompletedTask",
      "FailedTask",
      "CancelledTask",
    ]) {
      expect(defs[other]!.required, other).not.toContain("inputRequests");
    }
  });

  it("requires result only on completed, and types it as an object", () => {
    expect(defs.CompletedTask!.required).toContain("result");
    expect(
      (defs.CompletedTask!.properties as Record<string, unknown>).result,
    ).toMatchObject({ type: "object" });
    for (const other of [
      "WorkingTask",
      "InputRequiredTask",
      "FailedTask",
      "CancelledTask",
    ]) {
      expect(defs[other]!.required, other).not.toContain("result");
    }
  });

  // The draft typed this as any object. The snapshot requires a JSON-RPC error.
  it("requires error only on failed, as a JSON-RPC error object", () => {
    expect(defs.FailedTask!.required).toContain("error");
    expect(
      (defs.FailedTask!.properties as Record<string, unknown>).error,
    ).toEqual({ $ref: "#/$defs/Error" });
    expect(defs.Error!.required).toEqual(["code", "message"]);
    expect(
      (defs.Error!.properties as Record<string, unknown>).code,
    ).toMatchObject({ type: "integer" });
  });

  it("gives working and cancelled no extra fields beyond the base", () => {
    expect(defs.WorkingTask!.required).toEqual(BASE_REQUIRED);
    expect(defs.CancelledTask!.required).toEqual(BASE_REQUIRED);
  });
});

describe("the result discriminator is required, with a fixed value", () => {
  const handle = {
    taskId: "t",
    status: "working",
    createdAt: "2026-07-28T00:00:00.000Z",
    lastUpdatedAt: "2026-07-28T00:00:00.000Z",
    ttlMs: null,
  };

  it.each([
    ["CreateTaskResult", "task", "complete"],
    ["GetTaskResult", "complete", "task"],
  ])("%s requires resultType %j", (def, right, wrong) => {
    conforms(def, { ...handle, resultType: right });
    violates(def, handle);
    violates(def, { ...handle, resultType: wrong });
  });

  it.each(["UpdateTaskResult", "CancelTaskResult"])(
    "%s is an acknowledgement that still requires resultType",
    (def) => {
      conforms(def, { resultType: "complete" });
      violates(def, {});
      violates(def, { resultType: "task" });
    },
  );
});

describe("there is still no enumeration API (I7)", () => {
  it("defines no tasks/list request or result", () => {
    expect(Object.keys(defs).join(" ")).not.toMatch(/ListTasks/);
  });
});

describe("the input unions are concrete (A8)", () => {
  // The pre-stable draft degraded both to `anyOf: [{}, {}, {}]`, which accepts
  // anything. The snapshot references the real MCP definitions instead.
  it("defines InputRequest as the three server-to-client requests", () => {
    expect(defs.InputRequest!.anyOf).toEqual([
      { $ref: "#/$defs/CreateMessageRequest" },
      { $ref: "#/$defs/ListRootsRequest" },
      { $ref: "#/$defs/ElicitRequest" },
    ]);
  });

  it("defines InputResponse as their three results", () => {
    expect(defs.InputResponse!.anyOf).toEqual([
      { $ref: "#/$defs/CreateMessageResult" },
      { $ref: "#/$defs/ListRootsResult" },
      { $ref: "#/$defs/ElicitResult" },
    ]);
  });

  it("rejects values the degraded draft union accepted", () => {
    violates("InputRequest", { definitely: "not an MCP request" });
    violates("InputRequest", { method: "tools/call", params: {} });
    violates("InputResponse", { definitely: "not an MCP result" });
    violates("InputRequiredTask", {
      resultType: "complete",
      taskId: "t",
      status: "input_required",
      createdAt: "2026-07-28T00:00:00.000Z",
      lastUpdatedAt: "2026-07-28T00:00:00.000Z",
      ttlMs: null,
      inputRequests: { a: { method: "tools/call" } },
    });
  });
});

describe("the TypeScript source, which is authoritative", () => {
  const source = fixture("schema.ts");
  const base = fixture("spec.types.ts");

  it("declares itself the source of truth, immutable for this revision", () => {
    expect(source).toContain("source of truth");
    expect(source).toContain("This released snapshot is immutable");
  });

  it("imports the input maps from the vendored MCP base types", () => {
    expect(source).toMatch(
      /import type \{[^}]*\bInputRequests\b[^}]*\} from "\.\/spec\.types\.js"/,
    );
  });

  it("types input requests as the three server-to-client MCP requests", () => {
    expect(base).toMatch(
      /export type InputRequest =\s*\|?\s*CreateMessageRequest\s*\|\s*ListRootsRequest\s*\|\s*ElicitRequest\s*;/,
    );
  });
});

/* == 2. What the engine emits =========================================== */

describe("engine outputs validate against the stable schema", () => {
  it("createTask returns a conforming CreateTaskResult", async () => {
    const lifecycle = engine();
    conforms("CreateTaskResult", await lifecycle.createTask());
    conforms(
      "CreateTaskResult",
      await lifecycle.createTask({ ttlMs: null, statusMessage: "queued" }),
    );
    await lifecycle.close();
  });

  it("omits pollIntervalMs rather than emitting a non-integer when disabled", async () => {
    const lifecycle = engine({ defaultPollIntervalMs: null });
    const created = await lifecycle.createTask();
    expect(created).not.toHaveProperty("pollIntervalMs");
    conforms("CreateTaskResult", created);
    conformsAsGetResult(await lifecycle.getTask(created.taskId));
    await lifecycle.close();
  });

  it("projects working, including revised hints", async () => {
    const lifecycle = engine();
    const { taskId } = await lifecycle.createTask();
    conformsAsGetResult(await lifecycle.getTask(taskId));

    await lifecycle
      .handle(taskId)
      .progress("halfway", { pollIntervalMs: 2_000, ttlMs: 60_000 });
    const view = await lifecycle.getTask(taskId);
    expect(view).toMatchObject({ status: "working", statusMessage: "halfway" });
    conformsAsGetResult(view);
    await lifecycle.close();
  });

  it("projects input_required with every request type, across a partial round", async () => {
    const lifecycle = engine();
    const { taskId } = await lifecycle.createTask();
    const handle = lifecycle.handle(taskId);
    const parked = handle.requestInput({ s: SAMPLING, r: ROOTS, e: ELICIT });

    const first = await untilParked(lifecycle, taskId);
    conformsAsGetResult(first);
    for (const request of Object.values(
      (first as { inputRequests: Record<string, unknown> }).inputRequests,
    )) {
      conforms("InputRequest", request);
    }

    // A partial answer keeps the task parked; the stored partial responses
    // must not appear, and what does appear must still conform.
    const ack = await lifecycle.updateTask(taskId, {
      r: { roots: [{ uri: "file:///repo" }] },
    });
    conforms("UpdateTaskResult", ack);
    const partial = await lifecycle.getTask(taskId);
    expect(partial.status).toBe("input_required");
    conformsAsGetResult(partial);

    const rest = {
      s: { model: "m", role: "assistant", content: TEXT },
      e: { action: "accept", content: { confirm: true } },
    };
    for (const response of Object.values(rest)) {
      conforms("InputResponse", response);
    }
    conforms("UpdateTaskResult", await lifecycle.updateTask(taskId, rest));
    await parked;
    const resumed = await lifecycle.getTask(taskId);
    expect(resumed.status).toBe("working");
    conformsAsGetResult(resumed);
    await lifecycle.close();
  });

  it("carries the 2026-07-28-only input shapes through a full round", async () => {
    const lifecycle = engine();
    const { taskId } = await lifecycle.createTask();
    const requests: Record<string, InputRequest> = {
      url: {
        method: "elicitation/create",
        params: {
          mode: "url",
          message: "Sign in",
          url: "https://example.test",
        },
      },
      tool: {
        method: "sampling/createMessage",
        params: {
          messages: [{ role: "user", content: TEXT }],
          maxTokens: 8,
          tools: [
            {
              name: "count",
              inputSchema: { type: "object" },
              outputSchema: { type: "integer" },
            },
          ],
        },
      },
    };
    const parked = lifecycle.handle(taskId).requestInput(requests);

    const view = await untilParked(lifecycle, taskId);
    conformsAsGetResult(view);
    expect(
      (view as { inputRequests: Record<string, unknown> }).inputRequests,
    ).toEqual(requests);

    const answers = {
      url: { action: "accept" },
      tool: {
        model: "m",
        role: "user",
        content: {
          type: "tool_result",
          toolUseId: "call-1",
          content: [],
          structuredContent: 3,
        },
      },
    };
    conforms("UpdateTaskResult", await lifecycle.updateTask(taskId, answers));
    await expect(parked).resolves.toEqual(answers);
    conformsAsGetResult(await lifecycle.getTask(taskId));
    await lifecycle.close();
  });

  it("projects completed with its result", async () => {
    const lifecycle = engine();
    const { taskId } = await lifecycle.createTask();
    await lifecycle
      .handle(taskId)
      .complete({ content: [TEXT], isError: false, structuredContent: {} });
    const view = await lifecycle.getTask(taskId);
    expect(view.status).toBe("completed");
    conformsAsGetResult(view);
    await lifecycle.close();
  });

  it("projects failed with a JSON-RPC error", async () => {
    const lifecycle = engine();
    const { taskId } = await lifecycle.createTask();
    await lifecycle
      .handle(taskId)
      .fail({ code: -32603, message: "boom", data: { attempt: 1 } });
    const view = await lifecycle.getTask(taskId);
    expect(view.status).toBe("failed");
    conformsAsGetResult(view);
    await lifecycle.close();
  });

  it("acknowledges cancellation and projects cancelled", async () => {
    const lifecycle = engine();
    const { taskId } = await lifecycle.createTask();
    conforms("CancelTaskResult", await lifecycle.cancelTask(taskId));
    await lifecycle.handle(taskId).cancelled("stopped on request");
    const view = await lifecycle.getTask(taskId);
    expect(view.status).toBe("cancelled");
    conformsAsGetResult(view);

    // Late update and cancel on a terminal task are empty acknowledgements.
    conforms("UpdateTaskResult", await lifecycle.updateTask(taskId, {}));
    conforms("CancelTaskResult", await lifecycle.cancelTask(taskId));
    await lifecycle.close();
  });
});

describe("the validator is not vacuous", () => {
  // Without these, a misconfigured validator that accepts everything would
  // make every test above pass.
  const valid = {
    resultType: "complete",
    taskId: "t",
    status: "working",
    createdAt: "2026-07-28T00:00:00.000Z",
    lastUpdatedAt: "2026-07-28T00:00:00.000Z",
    ttlMs: 60_000,
  };

  it.each<[string, Record<string, unknown>]>([
    ["no resultType", { resultType: undefined }],
    ["no taskId", { taskId: undefined }],
    ["an unknown status", { status: "paused" }],
    ["a fractional ttlMs", { ttlMs: 1.5 }],
    ["a string ttlMs", { ttlMs: "60000" }],
    ["a ttlMs beyond the safe integer range", { ttlMs: 2 ** 53 }],
    ["a fractional pollIntervalMs", { pollIntervalMs: 0.5 }],
    ["a non-string statusMessage", { statusMessage: 42 }],
    ["input_required without inputRequests", { status: "input_required" }],
    ["completed without result", { status: "completed" }],
    ["completed with an array result", { status: "completed", result: [] }],
    ["failed without error", { status: "failed" }],
    [
      "failed with an error that is not JSON-RPC",
      { status: "failed", error: { reason: "x" } },
    ],
    [
      "failed with a fractional error code",
      { status: "failed", error: { code: 1.5, message: "m" } },
    ],
  ])("rejects a tasks/get result with %s", (_name, change) => {
    const candidate: Record<string, unknown> = { ...valid, ...change };
    for (const [key, value] of Object.entries(change)) {
      if (value === undefined) delete candidate[key];
    }
    conforms("GetTaskResult", valid);
    violates("GetTaskResult", candidate);
  });
});

/* == 3. The closed wire: a package guarantee, not a schema one ========== */

const BASE_KEYS = [
  "resultType",
  "taskId",
  "status",
  "createdAt",
  "lastUpdatedAt",
  "ttlMs",
];
const OPTIONAL_KEYS = ["statusMessage", "pollIntervalMs"];
const STATUS_KEYS: Record<keyof typeof VARIANT, string[]> = {
  working: [],
  input_required: ["inputRequests"],
  completed: ["result"],
  failed: ["error"],
  cancelled: [],
};

/** Exactly the allow-listed keys for the status: required present, nothing else. */
function expectClosed(view: Record<string, unknown>) {
  const status = view.status as keyof typeof VARIANT;
  const allowed = [...BASE_KEYS, ...OPTIONAL_KEYS, ...STATUS_KEYS[status]];
  expect(Object.keys(view).filter((key) => !allowed.includes(key))).toEqual([]);
  for (const key of [...BASE_KEYS, ...STATUS_KEYS[status]]) {
    expect(view, key).toHaveProperty(key);
  }
}

describe("the wire projection is closed", () => {
  const stamp = "2026-07-28T00:00:00.000Z";
  // Every status, each record also carrying the three internal fields a
  // correct store keeps plus one field nobody has listed yet. The stable
  // schema accepts all of them (see above); the projection must not.
  const internals = {
    version: 3,
    usedInputKeys: ["a"],
    futureInternalField: "must never reach the wire",
  };
  const records: [string, Record<string, unknown>][] = [
    ["working", { status: "working" }],
    [
      "input_required",
      {
        status: "input_required",
        inputRequests: { a: ROOTS },
        inputResponses: {},
      },
    ],
    ["completed", { status: "completed", result: { ok: true } }],
    ["failed", { status: "failed", error: { code: -32603, message: "boom" } }],
    ["cancelled", { status: "cancelled", statusMessage: "stopped" }],
  ];

  it.each(records)(
    "emits only allow-listed fields for %s",
    async (_status, fields) => {
      const store = new MemoryTaskStore();
      await store.create({
        taskId: "t",
        createdAt: stamp,
        lastUpdatedAt: stamp,
        ttlMs: null,
        pollIntervalMs: 500,
        ...internals,
        ...fields,
      } as unknown as TaskRecord);
      const lifecycle = new TaskLifecycle({ store, sweepIntervalMs: null });

      const view = (await lifecycle.getTask("t")) as unknown as Record<
        string,
        unknown
      >;
      expectClosed(view);
      for (const key of [
        "version",
        "usedInputKeys",
        "inputResponses",
        "futureInternalField",
      ]) {
        expect(view, key).not.toHaveProperty(key);
      }
      conformsAsGetResult(view as { status: keyof typeof VARIANT });
      await lifecycle.close();
    },
  );

  it("keeps CreateTaskResult to the base task, with no status payloads", async () => {
    const lifecycle = engine();
    const created = (await lifecycle.createTask({
      statusMessage: "queued",
    })) as unknown as Record<string, unknown>;
    expect(
      Object.keys(created).filter(
        (key) => ![...BASE_KEYS, ...OPTIONAL_KEYS].includes(key),
      ),
    ).toEqual([]);
    await lifecycle.close();
  });

  // Error paths: a stored record whose payloads contradict its status would
  // project into a variant the schema rejects (or silently drop data). The
  // engine refuses to answer rather than emit either.
  it.each<[string, Record<string, unknown>]>([
    ["completed without result", { status: "completed" }],
    ["failed without error", { status: "failed" }],
    ["input_required without inputRequests", { status: "input_required" }],
    ["working with a result", { status: "working", result: {} }],
    [
      "cancelled with pending input",
      { status: "cancelled", inputRequests: { a: ROOTS } },
    ],
    [
      "completed that also carries an error",
      { status: "completed", result: {}, error: { code: 1, message: "m" } },
    ],
  ])("refuses to project a stored task that is %s", async (_name, fields) => {
    const store = new MemoryTaskStore();
    await store.create({
      taskId: "corrupt",
      createdAt: stamp,
      lastUpdatedAt: stamp,
      ttlMs: null,
      version: 0,
      ...fields,
    } as unknown as TaskRecord);
    const lifecycle = new TaskLifecycle({ store, sweepIntervalMs: null });
    await expect(lifecycle.getTask("corrupt")).rejects.toThrow(/inconsistent/i);
    await lifecycle.close();
  });
});

/* == 4. Runtime input validation against the stable definitions ========= */

const sampling = (params: Record<string, unknown>) => ({
  method: "sampling/createMessage",
  params,
});
const elicit = (params: Record<string, unknown>) => ({
  method: "elicitation/create",
  params,
});
const RESULT_DEF = {
  "sampling/createMessage": "CreateMessageResult",
  "roots/list": "ListRootsResult",
  "elicitation/create": "ElicitResult",
} as const;

function engineAcceptsResponse(request: InputRequest, response: unknown) {
  try {
    assertInputResponse(request, response, "k");
    return true;
  } catch {
    return false;
  }
}

describe("runtime input validation agrees with the stable definitions", () => {
  // The engine's validator (src/input.ts) predates the stable schema and was
  // written from @modelcontextprotocol/sdk@1.30.0. These are the shapes on
  // which it and 2026-07-28 agree; the divergences are pinned separately
  // below.
  it.each<[string, unknown, boolean]>([
    ["a minimal roots request", { method: "roots/list" }, true],
    ["a sampling request", SAMPLING, true],
    ["a form elicitation request", ELICIT, true],
    [
      "sampling with content arrays and model preferences",
      sampling({
        messages: [{ role: "assistant", content: [TEXT, TEXT] }],
        maxTokens: 8,
        modelPreferences: { costPriority: 0.5, hints: [{ name: "x" }] },
      }),
      true,
    ],
    ["a method MCP does not define", { method: "tools/call" }, false],
    ["a bare object", {}, false],
    ["null", null, false],
    [
      "roots with non-object params",
      { method: "roots/list", params: 42 },
      false,
    ],
    ["sampling with no params", { method: "sampling/createMessage" }, false],
    [
      "sampling with fractional maxTokens",
      sampling({ messages: [{ role: "user", content: TEXT }], maxTokens: 1.5 }),
      false,
    ],
    [
      "sampling with an unknown role",
      sampling({ messages: [{ role: "system", content: TEXT }], maxTokens: 1 }),
      false,
    ],
    ["elicitation with no schema", elicit({ message: "Continue?" }), false],
    [
      "elicitation in url mode with no url",
      elicit({ message: "Sign in", mode: "url" }),
      false,
    ],
    [
      "elicitation in url mode, 2026-07-28 shape",
      elicit({ message: "Sign in", mode: "url", url: "https://example.test" }),
      true,
    ],
    [
      "elicitation in url mode, still carrying a 2025-11-25 elicitationId",
      elicit({
        message: "Sign in",
        mode: "url",
        elicitationId: "id",
        url: "https://example.test",
      }),
      true,
    ],
    [
      "a sampling tool whose outputSchema is a boolean schema",
      sampling({
        messages: [{ role: "user", content: TEXT }],
        maxTokens: 1,
        tools: [
          { name: "t", inputSchema: { type: "object" }, outputSchema: true },
        ],
      }),
      false,
    ],
    [
      "a sampling tool whose inputSchema is not object-rooted",
      sampling({
        messages: [{ role: "user", content: TEXT }],
        maxTokens: 1,
        tools: [{ name: "t", inputSchema: { type: "string" } }],
      }),
      false,
    ],
    [
      "elicitation in an unknown mode",
      elicit({ message: "?", mode: "x" }),
      false,
    ],
    // `SamplingMessageContentBlock` is text, image, audio, tool_use and
    // tool_result only. Resource links and embedded resources are
    // `ContentBlock`s, valid inside a tool_result's `content` but not as a
    // sampling message's own content.
    [
      "a sampling message whose content is a resource_link",
      sampling({
        messages: [{ role: "user", content: RESOURCE_LINK }],
        maxTokens: 1,
      }),
      false,
    ],
    [
      "a sampling message whose content array holds an embedded resource",
      sampling({
        messages: [{ role: "user", content: [TEXT, EMBEDDED_RESOURCE] }],
        maxTokens: 1,
      }),
      false,
    ],
    [
      "a tool_result whose own content carries a resource_link and a resource",
      sampling({
        messages: [
          {
            role: "user",
            content: {
              type: "tool_result",
              toolUseId: "call-1",
              content: [RESOURCE_LINK, EMBEDDED_RESOURCE],
            },
          },
        ],
        maxTokens: 1,
      }),
      true,
    ],
  ])("request: %s", (_name, value, expected) => {
    expect(isInputRequest(value)).toBe(expected);
    expect(errorsAgainst("InputRequest", value).length === 0).toBe(expected);
  });

  it.each<[string, InputRequest, unknown, boolean]>([
    ["an empty roots list", ROOTS, { roots: [] }, true],
    ["a root without uri", ROOTS, { roots: [{ name: "a" }] }, false],
    [
      "a sampling result",
      SAMPLING,
      { model: "m", role: "assistant", content: TEXT },
      true,
    ],
    ["a sampling result with no model", SAMPLING, { role: "assistant" }, false],
    ["a declined elicitation", ELICIT, { action: "decline" }, true],
    ["an unknown elicitation action", ELICIT, { action: "maybe" }, false],
    [
      "nested elicitation content",
      ELICIT,
      { action: "accept", content: { a: { b: 1 } } },
      false,
    ],
    ...(
      [
        ["an object", { celsius: 22 }],
        ["an array", []],
        ["a string", "22C"],
        ["a number", 22],
        ["null", null],
      ] as const
    ).map(
      ([name, structuredContent]) =>
        [
          `tool_result structuredContent as ${name}`,
          SAMPLING,
          {
            model: "m",
            role: "assistant",
            content: {
              type: "tool_result",
              toolUseId: "call-1",
              content: [],
              structuredContent,
            },
          },
          true,
        ] as [string, InputRequest, unknown, boolean],
    ),
    [
      "a tool_result with no toolUseId",
      SAMPLING,
      {
        model: "m",
        role: "assistant",
        content: { type: "tool_result", content: [], structuredContent: {} },
      },
      false,
    ],
    [
      "a sampling result whose content is a resource_link",
      SAMPLING,
      { model: "m", role: "assistant", content: RESOURCE_LINK },
      false,
    ],
    [
      "a sampling result whose content array holds an embedded resource",
      SAMPLING,
      { model: "m", role: "assistant", content: [EMBEDDED_RESOURCE] },
      false,
    ],
    [
      "a sampling result with a tool_result carrying a resource_link",
      SAMPLING,
      {
        model: "m",
        role: "assistant",
        content: {
          type: "tool_result",
          toolUseId: "call-1",
          content: [RESOURCE_LINK],
        },
      },
      true,
    ],
  ])("response: %s", (_name, request, response, expected) => {
    expect(engineAcceptsResponse(request, response)).toBe(expected);
    expect(
      errorsAgainst(RESULT_DEF[request.method], response).length === 0,
    ).toBe(expected);
  });
});

describe("where the engine is deliberately stricter than the schema", () => {
  // The schema states these as `format` annotations or in prose, which a
  // 2020-12 validator does not enforce by default. The engine enforces the
  // stated intent. Pinned so a change on either side is noticed.
  it("refuses non-Base64 binary content (`format: byte`)", () => {
    const request = sampling({
      messages: [
        {
          role: "user",
          content: { type: "image", data: "not base64!", mimeType: "x" },
        },
      ],
      maxTokens: 1,
    });
    expect(isInputRequest(request)).toBe(false);
    conforms("InputRequest", request);
  });

  it("refuses a URL elicitation whose url does not parse (`format: uri`)", () => {
    const request = elicit({
      message: "Sign in",
      mode: "url",
      elicitationId: "id",
      url: "not a URL",
    });
    expect(isInputRequest(request)).toBe(false);
    conforms("InputRequest", request);
  });

  it("refuses a root that is not file:// (stated in the Root description)", () => {
    const response = { roots: [{ uri: "https://example.test" }] };
    expect(engineAcceptsResponse(ROOTS, response)).toBe(false);
    conforms("ListRootsResult", response);
  });
});

describe("where the generated schema is narrower than its TypeScript source", () => {
  // `ElicitResult.content` values are `number` in spec.types.ts but `integer`
  // in schema.json (inherited from the MCP base schema). The engine follows
  // the TypeScript, which upstream declares authoritative.
  it("accepts a fractional elicitation value the JSON Schema rejects", () => {
    const response = { action: "accept", content: { ratio: 0.5 } };
    expect(engineAcceptsResponse(ELICIT, response)).toBe(true);
    violates("ElicitResult", response);
    expect(fixture("spec.types.ts")).toContain(
      "content?: { [key: string]: string | number | boolean | string[] };",
    );
  });

  // `StringSchema.minLength`/`maxLength` and the multi-select enums'
  // `minItems`/`maxItems` are `number` in spec.types.ts and `integer` in
  // schema.json. Same ruling: the engine follows the TypeScript.
  it.each([
    ["minLength", { type: "string", minLength: 1.5 }],
    ["maxLength", { type: "string", maxLength: 2.5 }],
    [
      "minItems",
      { type: "array", items: { type: "string", enum: ["a"] }, minItems: 0.5 },
    ],
    [
      "maxItems",
      {
        type: "array",
        items: { anyOf: [{ const: "a", title: "A" }] },
        maxItems: 1.5,
      },
    ],
  ])("accepts a fractional %s the JSON Schema rejects", (field, property) => {
    const request = elicit({
      message: "?",
      requestedSchema: { type: "object", properties: { p: property } },
    });
    expect(isInputRequest(request)).toBe(true);
    violates("InputRequest", request);
    expect(fixture("spec.types.ts")).toContain(`${field}?: number;`);
  });
});

describe("divergences pinned for a decision, not deliberate", () => {
  // Found while aligning the three shapes fixed in section 5 and left as they
  // were, because changing them was outside that change's scope. Pinned so
  // whichever way they are decided, the change is visible here
  // (docs/contract.md#input-rounds).
  const withTool = (tool: Record<string, unknown>) =>
    sampling({
      messages: [{ role: "user", content: TEXT }],
      maxTokens: 1,
      tools: [{ name: "t", inputSchema: { type: "object" }, ...tool }],
    });

  it("refuses an unknown tool execution.taskSupport (an SDK 1.30.0 field 2026-07-28 Tool does not define)", () => {
    const request = withTool({ execution: { taskSupport: "sometimes" } });
    expect(isInputRequest(request)).toBe(false);
    conforms("InputRequest", request);
  });

  it("accepts a non-string `$schema` in a tool schema, which the schema rejects", () => {
    for (const tool of [
      { inputSchema: { type: "object", $schema: 7 } },
      { outputSchema: { $schema: 7 } },
    ]) {
      const request = withTool(tool);
      expect(isInputRequest(request)).toBe(true);
      violates("InputRequest", request);
    }
  });
});

/* == 5. Engine defects found by this validation ========================= */

// Found by validating engine output against the stable schema. A defect that
// is still open is an `it.fails`: it passes while the defect exists and turns
// red the moment the engine is fixed, at which point it becomes a plain `it`
// with the same assertion, as the `fixed:` blocks below did. Fixing one is a
// separate, reviewed engine change (AGENTS.md: failing test first, then ask).

/**
 * Whatever the eventual fix — rejecting the input or normalising it — the
 * engine must never leave a task whose `tasks/get` the stable schema rejects.
 */
async function neverEmitsNonConforming(
  work: (lifecycle: TaskLifecycle) => Promise<string>,
) {
  const lifecycle = engine();
  let taskId: string;
  try {
    taskId = await work(lifecycle);
  } catch (error) {
    expect(error).toBeInstanceOf(TypeError);
    await lifecycle.close();
    return;
  }
  conformsAsGetResult(await lifecycle.getTask(taskId));
  await lifecycle.close();
}

const created = async (
  lifecycle: TaskLifecycle,
  init: Parameters<TaskLifecycle["createTask"]>[0],
) => (await lifecycle.createTask(init)).taskId;

const afterHandle = async (
  lifecycle: TaskLifecycle,
  step: (handle: TaskHandle) => Promise<void>,
) => {
  const { taskId } = await lifecycle.createTask();
  await step(lifecycle.handle(taskId));
  return taskId;
};

describe("fixed: integer milliseconds are enforced at the API", () => {
  it("createTask() with a fractional ttlMs", () =>
    neverEmitsNonConforming((l) => created(l, { ttlMs: 1.5 })));
  it("createTask() with a ttlMs beyond the safe integer range", () =>
    neverEmitsNonConforming((l) => created(l, { ttlMs: 2 ** 53 })));
  it("createTask() with a fractional pollIntervalMs", () =>
    neverEmitsNonConforming((l) => created(l, { pollIntervalMs: 0.5 })));
  it("progress() with a fractional ttlMs", () =>
    neverEmitsNonConforming((l) =>
      afterHandle(l, (h) => h.progress("x", { ttlMs: 2.5 })),
    ));
  it("progress() with a fractional pollIntervalMs", () =>
    neverEmitsNonConforming((l) =>
      afterHandle(l, (h) => h.progress("x", { pollIntervalMs: 0.5 })),
    ));
});

describe("fixed: fail() requires a JSON-RPC error", () => {
  it("fail() with an object that has no code or message", () =>
    neverEmitsNonConforming((l) =>
      afterHandle(l, (h) => h.fail({ reason: "x" })),
    ));
  it("fail() with a fractional error code", () =>
    neverEmitsNonConforming((l) =>
      afterHandle(l, (h) => h.fail({ code: 1.5, message: "m" })),
    ));
});

describe("fixed: progress() checks statusMessage at runtime", () => {
  // Unreachable from typed TypeScript; reachable from JavaScript.
  it("progress() with a non-string statusMessage", () =>
    neverEmitsNonConforming((l) =>
      afterHandle(l, (h) => h.progress(42 as unknown as string)),
    ));
});

describe("fixed: input validation accepts these 2026-07-28 shapes", () => {
  // The engine followed the SDK 1.30.0 (2025-11-25) shapes here and refused
  // a worker or client that follows the 2026-07-28 definitions. The three
  // rules are now aligned with the stable MCP base types.
  it("accepts a URL elicitation without elicitationId", () => {
    const request = elicit({
      message: "Sign in",
      mode: "url",
      url: "https://example.test",
    });
    conforms("InputRequest", request);
    expect(isInputRequest(request)).toBe(true);
  });

  it("accepts a sampling tool whose outputSchema is not object-rooted", () => {
    const request = sampling({
      messages: [{ role: "user", content: TEXT }],
      maxTokens: 1,
      tools: [
        {
          name: "t",
          inputSchema: { type: "object" },
          outputSchema: { type: "string" },
        },
      ],
    });
    conforms("InputRequest", request);
    expect(isInputRequest(request)).toBe(true);
  });

  it("accepts a tool_result whose structuredContent is not an object", () => {
    const response = {
      model: "m",
      role: "assistant",
      content: {
        type: "tool_result",
        toolUseId: "call-1",
        content: [],
        structuredContent: [],
      },
    };
    conforms("CreateMessageResult", response);
    expect(engineAcceptsResponse(SAMPLING, response)).toBe(true);
  });
});

describe("fixed: a form elicitation's requestedSchema.$schema must be a string", () => {
  // Both the generated schema and spec.types.ts (`$schema?: string`) type it
  // as a string, so refusing anything else cannot refuse a shape the
  // TypeScript allows.
  const withSchema = ($schema: unknown) =>
    elicit({
      message: "?",
      requestedSchema: { $schema, type: "object", properties: {} },
    });

  it("refuses a non-string $schema, as both definitions do", () => {
    for (const $schema of [7, null, {}, ["x"]]) {
      const request = withSchema($schema);
      expect(isInputRequest(request)).toBe(false);
      violates("InputRequest", request);
    }
    expect(fixture("spec.types.ts")).toMatch(
      /requestedSchema: \{\s+\$schema\?: string;/,
    );
  });

  it("still accepts a string $schema, and one that is absent", () => {
    for (const request of [
      withSchema("https://json-schema.org/draft/2020-12/schema"),
      elicit({
        message: "?",
        requestedSchema: { type: "object", properties: {} },
      }),
    ]) {
      expect(isInputRequest(request)).toBe(true);
      conforms("InputRequest", request);
    }
  });
});

describe("fixed: sampling content is limited to SamplingMessageContentBlock", () => {
  // The engine reused the tool-result block set (which includes resource
  // links and embedded resources) for a sampling message's own content, so a
  // request the schema rejects parked the task and reached `tasks/get`, and a
  // result the schema rejects resumed the worker.
  it("requestInput() refuses a resource_link message and leaves the task working", async () => {
    const lifecycle = engine();
    const { taskId } = await lifecycle.createTask();
    const request = sampling({
      messages: [{ role: "user", content: RESOURCE_LINK }],
      maxTokens: 1,
    }) as InputRequest;
    violates("InputRequest", request);
    await expect(
      lifecycle.handle(taskId).requestInput({ k: request }),
    ).rejects.toBeInstanceOf(TypeError);
    const view = await lifecycle.getTask(taskId);
    expect(view.status).toBe("working");
    conformsAsGetResult(view);
    await lifecycle.close();
  });

  it("updateTask() refuses a resource content result and keeps the round open", async () => {
    const lifecycle = engine();
    const { taskId } = await lifecycle.createTask();
    const parked = lifecycle.handle(taskId).requestInput({ k: SAMPLING });
    void parked.catch(() => undefined);
    await untilParked(lifecycle, taskId);

    const response = {
      model: "m",
      role: "assistant",
      content: [EMBEDDED_RESOURCE],
    };
    violates("CreateMessageResult", response);
    await expect(
      lifecycle.updateTask(taskId, { k: response }),
    ).rejects.toBeInstanceOf(TypeError);
    conformsAsGetResult(await untilParked(lifecycle, taskId));
    await lifecycle.close();
  });
});
