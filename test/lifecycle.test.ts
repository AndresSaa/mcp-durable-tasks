import { beforeEach, describe, expect, it, vi } from "vitest";
import * as publicApi from "../src/index.js";
import {
  ConcurrentUpdateError,
  DuplicateInputKeyError,
  MemoryTaskStore,
  TaskAlreadyTerminalError,
  TaskCancelled,
  TaskLifecycle,
  TaskNotFoundError,
  type InputRequest,
  type TaskRecord,
  type TaskStore,
} from "../src/index.js";

const SAMPLING: InputRequest = {
  method: "sampling/createMessage",
  params: { messages: [], maxTokens: 128 },
};
const ROOTS: InputRequest = { method: "roots/list" };
const ELICIT: InputRequest = {
  method: "elicitation/create",
  params: {
    message: "Continue?",
    requestedSchema: { type: "object", properties: {} },
  },
};

function samplingResponse(extra: Record<string, unknown> = {}) {
  return {
    model: "test-model",
    role: "assistant" as const,
    content: { type: "text", text: "done" },
    ...extra,
  };
}

function rootsResponse(extra: Record<string, unknown> = {}) {
  return { roots: [], ...extra };
}

function elicitResponse(extra: Record<string, unknown> = {}) {
  return { action: "accept" as const, content: {}, ...extra };
}

/** A controllable clock, so TTL and monotonicity are testable without sleeping. */
function clock(start = Date.parse("2026-08-09T12:00:00.000Z")) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
    set: (ms: number) => {
      current = ms;
    },
  };
}

function build(overrides: Partial<{ ttlMs: number | null }> = {}) {
  const time = clock();
  const store = new MemoryTaskStore({ now: time.now });
  const engine = new TaskLifecycle({
    store,
    now: time.now,
    sweepIntervalMs: null,
    ...overrides,
  });
  return { time, store, engine };
}

/**
 * Waits until the task has actually reached `input_required`.
 *
 * `requestInput()` returns the promise that settles when every key is
 * *answered*, so there is no handle on the earlier moment when the task is
 * merely parked. In production that gap is invisible — a client only learns
 * which keys exist by polling `tasks/get`, so it cannot answer before the park
 * has landed. In a test both sides run in the same tick, so the wait has to be
 * explicit or the update races the registration.
 */
async function untilParked(engine: TaskLifecycle, taskId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const view = await engine.getTask(taskId);
    if (view.status === "input_required") return view;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`task ${taskId} never reached input_required`);
}

describe("createTask (I1)", () => {
  it("does not resolve until the store has the task", async () => {
    const order: string[] = [];
    const inner = new MemoryTaskStore();
    const store: TaskStore = {
      async create(record) {
        await new Promise((r) => setTimeout(r, 5));
        order.push("stored");
        return inner.create(record);
      },
      get: (id) => inner.get(id),
      update: (id, patch, v) => inner.update(id, patch, v),
      sweep: (now) => inner.sweep(now),
      close: () => inner.close(),
    };

    const engine = new TaskLifecycle({ store, sweepIntervalMs: null });
    const created = await engine.createTask();
    order.push("returned");

    expect(order).toEqual(["stored", "returned"]);
    // The invariant in its observable form: the ID it handed back resolves.
    await expect(engine.getTask(created.taskId)).resolves.toMatchObject({
      resultType: "complete",
      status: "working",
    });
  });

  it("returns the flat base task, with no status-specific fields", async () => {
    const { engine } = build();
    const created = await engine.createTask();
    expect(Object.keys(created).sort()).toEqual([
      "createdAt",
      "lastUpdatedAt",
      "pollIntervalMs",
      "resultType",
      "status",
      "taskId",
      "ttlMs",
    ]);
    expect(created.resultType).toBe("task");
  });

  it("omits pollIntervalMs when there is no hint to give", async () => {
    const engine = new TaskLifecycle({
      store: new MemoryTaskStore(),
      defaultPollIntervalMs: null,
      sweepIntervalMs: null,
    });
    const created = await engine.createTask();
    expect(created).not.toHaveProperty("pollIntervalMs");
    await engine.close();
  });
});

describe("task IDs (I6)", () => {
  it("sources every default id from a web-crypto CSPRNG", async () => {
    const randomUuid = vi.spyOn(globalThis.crypto, "randomUUID");
    const randomValues = vi.spyOn(globalThis.crypto, "getRandomValues");
    try {
      const { engine } = build();
      await engine.createTask();
      await engine.createTask();

      expect(
        randomUuid.mock.calls.length + randomValues.mock.calls.length,
      ).toBeGreaterThanOrEqual(2);
      await engine.close();
    } finally {
      randomUuid.mockRestore();
      randomValues.mockRestore();
    }
  });

  it("uses a CSPRNG and never repeats", async () => {
    const { engine } = build();
    const ids = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      ids.add((await engine.createTask()).taskId);
    }
    expect(ids.size).toBe(200);
    for (const id of ids) {
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
  });
});

describe("getTask (I3)", () => {
  it("mutates nothing at all, including lastUpdatedAt and version", async () => {
    const { engine, store, time } = build();
    const { taskId } = await engine.createTask();
    const before = await store.get(taskId);

    time.advance(60_000);
    await engine.getTask(taskId);
    await engine.getTask(taskId);

    expect(await store.get(taskId)).toEqual(before);
  });

  it("throws TaskNotFoundError for an unknown id", async () => {
    const { engine } = build();
    await expect(engine.getTask("nope")).rejects.toBeInstanceOf(
      TaskNotFoundError,
    );
  });
});

describe("the wire projection", () => {
  it("never leaks internal fields", async () => {
    const { engine } = build();
    const { taskId } = await engine.createTask();
    const handle = engine.handle(taskId);

    const parked = handle.requestInput({ a: SAMPLING });
    const view = await untilParked(engine, taskId);

    expect(view).not.toHaveProperty("version");
    expect(view).not.toHaveProperty("inputResponses");
    expect(view).not.toHaveProperty("usedInputKeys");

    await engine.updateTask(taskId, { a: samplingResponse({ ok: true }) });
    await parked;
  });

  it.each([
    [
      "failed",
      async (h: ReturnType<TaskLifecycle["handle"]>) =>
        h.fail({ code: -32000, message: "boom" }),
      { error: { code: -32000, message: "boom" } },
    ],
    [
      "cancelled",
      async (h: ReturnType<TaskLifecycle["handle"]>) => h.cancelled("gave up"),
      { statusMessage: "gave up" },
    ],
  ])(
    "projects a %s task without internal fields",
    async (status, finish, extra) => {
      const { engine } = build();
      const { taskId } = await engine.createTask();
      await finish(engine.handle(taskId));

      const view = await engine.getTask(taskId);
      expect(view).toMatchObject({ status, ...extra });
      expect(view).not.toHaveProperty("version");
      expect(view).not.toHaveProperty("usedInputKeys");
      expect(view).not.toHaveProperty("inputRequests");
    },
  );

  it("carries only the fields its status allows", async () => {
    const { engine } = build();
    const { taskId } = await engine.createTask();
    await engine.handle(taskId).complete({ answer: 42 });

    const view = await engine.getTask(taskId);
    expect(view).toMatchObject({ status: "completed", result: { answer: 42 } });
    expect(view).not.toHaveProperty("inputRequests");
    expect(view).not.toHaveProperty("error");
  });

  it("does not let callers mutate a stored terminal result through aliases", async () => {
    const { engine } = build();
    const { taskId } = await engine.createTask();
    const result = { answer: 1 };

    await engine.handle(taskId).complete(result);
    result.answer = 2;

    const first = await engine.getTask(taskId);
    expect(first).toMatchObject({ result: { answer: 1 } });
    if (first.status !== "completed") throw new Error("expected completed");
    first.result.answer = 3;

    await expect(engine.getTask(taskId)).resolves.toMatchObject({
      result: { answer: 1 },
    });
  });

  it("throws instead of fabricating a required terminal payload", async () => {
    const store = new MemoryTaskStore();
    const corrupt: TaskRecord = {
      taskId: "corrupt",
      status: "completed",
      createdAt: "2026-08-09T12:00:00.000Z",
      lastUpdatedAt: "2026-08-09T12:00:00.000Z",
      ttlMs: null,
      version: 0,
    };
    await store.create(corrupt);
    const engine = new TaskLifecycle({ store, sweepIntervalMs: null });

    await expect(engine.getTask("corrupt")).rejects.toThrow(/inconsistent/i);
    await engine.close();
  });
});

describe("the public lifecycle surface", () => {
  it("does not expose internal writers or an enumeration API", () => {
    expect(Object.getOwnPropertyNames(TaskLifecycle.prototype).sort()).toEqual([
      "cancelTask",
      "close",
      "constructor",
      "createTask",
      "getTask",
      "handle",
      "updateTask",
    ]);
    expect(
      Object.getOwnPropertyNames(MemoryTaskStore.prototype).sort(),
    ).toEqual(["close", "constructor", "create", "get", "sweep", "update"]);
    expect(Object.keys(publicApi).sort()).toEqual([
      "ConcurrentUpdateError",
      "DuplicateInputKeyError",
      "MemoryTaskStore",
      "TaskAlreadyTerminalError",
      "TaskCancelled",
      "TaskEntryTooLargeError",
      "TaskLifecycle",
      "TaskNotFoundError",
      "isConcurrentUpdateError",
      "isTaskEntryTooLargeError",
    ]);
  });
});

describe("terminality (I2)", () => {
  it.each([
    ["complete", (h: ReturnType<TaskLifecycle["handle"]>) => h.complete({})],
    ["fail", (h: ReturnType<TaskLifecycle["handle"]>) => h.fail({ code: -1 })],
    ["cancelled", (h: ReturnType<TaskLifecycle["handle"]>) => h.cancelled()],
  ])("refuses a second terminal transition after %s", async (_name, finish) => {
    const { engine } = build();
    const { taskId } = await engine.createTask();
    const handle = engine.handle(taskId);

    await finish(handle);
    await expect(handle.complete({})).rejects.toBeInstanceOf(
      TaskAlreadyTerminalError,
    );
    await expect(handle.progress("still going")).rejects.toBeInstanceOf(
      TaskAlreadyTerminalError,
    );
  });

  it("rejects requestInput on a finished task", async () => {
    const { engine } = build();
    const { taskId } = await engine.createTask();
    const handle = engine.handle(taskId);
    await handle.complete({});
    await expect(handle.requestInput({ x: ELICIT })).rejects.toBeInstanceOf(
      TaskAlreadyTerminalError,
    );
  });
});

describe("lastUpdatedAt (I4)", () => {
  it("never decreases, even when the clock steps backwards", async () => {
    const { engine, store, time } = build();
    const { taskId } = await engine.createTask();

    time.advance(10_000);
    await engine.handle(taskId).progress("one");
    const after = (await store.get(taskId))!.lastUpdatedAt;

    time.advance(-60_000);
    await engine.handle(taskId).progress("two");
    const later = (await store.get(taskId))!.lastUpdatedAt;

    expect(Date.parse(later)).toBeGreaterThanOrEqual(Date.parse(after));
  });

  it("is never earlier than createdAt", async () => {
    const { engine, store } = build();
    const { taskId } = await engine.createTask();
    await engine.handle(taskId).progress("hello");
    const record = (await store.get(taskId))!;
    expect(Date.parse(record.lastUpdatedAt)).toBeGreaterThanOrEqual(
      Date.parse(record.createdAt),
    );
  });
});

describe("the inputRequests round trip", () => {
  it("canonicalises signed zero in partial responses before committing", async () => {
    const { engine, store } = build();
    const { taskId } = await engine.createTask();
    const parked = engine.handle(taskId).requestInput({
      first: ELICIT,
      second: ELICIT,
    });
    await untilParked(engine, taskId);

    await engine.updateTask(taskId, {
      first: elicitResponse({ content: { signedZero: -0 } }),
    });
    const partial = await store.get(taskId);
    const storedZero = (
      partial?.inputResponses?.first as unknown as {
        content: { signedZero: number };
      }
    ).content.signedZero;
    expect(Object.is(storedZero, 0)).toBe(true);

    await engine.updateTask(taskId, { second: elicitResponse() });
    const responses = await parked;
    const returnedZero = (
      responses.first as unknown as { content: { signedZero: number } }
    ).content.signedZero;
    expect(Object.is(returnedZero, 0)).toBe(true);
  });

  it("parks the task and resolves once every key is answered", async () => {
    const { engine } = build();
    const { taskId } = await engine.createTask();
    const handle = engine.handle(taskId);

    const parked = handle.requestInput({ a: SAMPLING, b: ELICIT });

    const view = await untilParked(engine, taskId);
    expect(view.status).toBe("input_required");
    expect(
      Object.keys((view as { inputRequests: object }).inputRequests),
    ).toEqual(["a", "b"]);

    await engine.updateTask(taskId, {
      a: samplingResponse({ first: true }),
    });
    expect((await engine.getTask(taskId)).status).toBe("input_required");

    await engine.updateTask(taskId, { b: elicitResponse({ second: true }) });
    await expect(parked).resolves.toEqual({
      a: samplingResponse({ first: true }),
      b: elicitResponse({ second: true }),
    });
    expect((await engine.getTask(taskId)).status).toBe("working");
  });

  it("ignores keys that are not outstanding rather than rejecting them", async () => {
    const { engine } = build();
    const { taskId } = await engine.createTask();
    const handle = engine.handle(taskId);
    const parked = handle.requestInput({ a: SAMPLING });
    await untilParked(engine, taskId);

    // Never issued, mixed in with a good one. The good one applies.
    await expect(
      engine.updateTask(taskId, {
        ghost: { x: 1 },
        a: samplingResponse({ real: true }),
      }),
    ).resolves.toEqual({ resultType: "complete" });

    await expect(parked).resolves.toEqual({
      a: samplingResponse({ real: true }),
    });
  });

  it("treats a repeated answer as a no-op instead of an overwrite", async () => {
    const { engine } = build();
    const { taskId } = await engine.createTask();
    const handle = engine.handle(taskId);
    const parked = handle.requestInput({ a: SAMPLING, b: ELICIT });
    await untilParked(engine, taskId);

    await engine.updateTask(taskId, {
      a: samplingResponse({ attempt: 1 }),
    });
    await engine.updateTask(taskId, {
      a: samplingResponse({ attempt: 2 }),
    });
    await engine.updateTask(taskId, { b: elicitResponse({ done: true }) });

    await expect(parked).resolves.toEqual({
      a: samplingResponse({ attempt: 1 }),
      b: elicitResponse({ done: true }),
    });
  });

  it("does not confuse prototype properties with answered input keys", async () => {
    const { engine } = build();
    const { taskId } = await engine.createTask();
    const parked = engine
      .handle(taskId)
      .requestInput({ a: ROOTS, toString: ROOTS });
    await untilParked(engine, taskId);

    await engine.updateTask(taskId, { a: rootsResponse() });
    expect((await engine.getTask(taskId)).status).toBe("input_required");

    await engine.updateTask(taskId, { toString: rootsResponse() });
    await expect(parked).resolves.toEqual({
      a: rootsResponse(),
      toString: rootsResponse(),
    });
  });

  it("rejects a response that does not match its outstanding request", async () => {
    const { engine } = build();
    const { taskId } = await engine.createTask();
    const parked = engine.handle(taskId).requestInput({ a: ROOTS });
    await untilParked(engine, taskId);

    await expect(engine.updateTask(taskId, { a: 42 })).rejects.toBeInstanceOf(
      TypeError,
    );
    expect((await engine.getTask(taskId)).status).toBe("input_required");

    await engine.updateTask(taskId, { a: rootsResponse() });
    await parked;
  });

  it("rejects a structurally matching response with a non-JSON subtree", async () => {
    const { engine } = build();
    const { taskId } = await engine.createTask();
    const parked = engine.handle(taskId).requestInput({ a: ROOTS });
    await untilParked(engine, taskId);

    await expect(
      engine.updateTask(taskId, {
        a: { roots: [], metadata: new Map([["answer", 42]]) },
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect((await engine.getTask(taskId)).status).toBe("input_required");

    await engine.updateTask(taskId, { a: rootsResponse() });
    await parked;
  });

  it("registers the waiter before input_required becomes observable", async () => {
    const inner = new MemoryTaskStore();
    let releaseWrite!: () => void;
    let reportCommit!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const committed = new Promise<void>((resolve) => {
      reportCommit = resolve;
    });
    let delayInputWrite = true;
    const store: TaskStore = {
      create: (record) => inner.create(record),
      get: (id) => inner.get(id),
      async update(id, patch, version) {
        const written = await inner.update(id, patch, version);
        if (delayInputWrite && patch.status === "input_required") {
          delayInputWrite = false;
          reportCommit();
          await release;
        }
        return written;
      },
      sweep: (now) => inner.sweep(now),
      close: () => inner.close(),
    };
    const engine = new TaskLifecycle({ store, sweepIntervalMs: null });
    const { taskId } = await engine.createTask();

    const parked = engine.handle(taskId).requestInput({ a: ROOTS });
    await committed;
    expect((await engine.getTask(taskId)).status).toBe("input_required");

    await engine.updateTask(taskId, { a: rootsResponse() });
    releaseWrite();
    await expect(parked).resolves.toEqual({ a: rootsResponse() });
    expect((await engine.getTask(taskId)).status).toBe("working");
    await engine.close();
  });

  it("rejects a parked worker when another handle finishes the task", async () => {
    const { engine } = build();
    const { taskId } = await engine.createTask();
    const handle = engine.handle(taskId);
    const parked = handle.requestInput({ a: ROOTS });
    const rejection = expect(parked).rejects.toThrow(/became completed/i);
    await untilParked(engine, taskId);

    await engine.handle(taskId).complete({ done: true });
    await rejection;
  });

  it("acknowledges an update to a finished task instead of failing it", async () => {
    const { engine } = build();
    const { taskId } = await engine.createTask();
    await engine.handle(taskId).complete({});
    // A late response racing a task that just completed is legal, and every key
    // in it is by definition no longer outstanding.
    await expect(
      engine.updateTask(taskId, { a: { late: true } }),
    ).resolves.toEqual({ resultType: "complete" });
  });

  it("still reports an unknown task", async () => {
    const { engine } = build();
    await expect(engine.updateTask("nope", {})).rejects.toBeInstanceOf(
      TaskNotFoundError,
    );
  });

  it("refuses to reuse a key for the task's lifetime (I5)", async () => {
    const { engine } = build();
    const { taskId } = await engine.createTask();
    const handle = engine.handle(taskId);

    const first = handle.requestInput({ a: SAMPLING });
    await untilParked(engine, taskId);
    await engine.updateTask(taskId, { a: samplingResponse({ done: 1 }) });
    await first;

    await expect(handle.requestInput({ a: ELICIT })).rejects.toBeInstanceOf(
      DuplicateInputKeyError,
    );
  });

  it("keeps the used-key ledger after the task is terminal (I5)", async () => {
    const { engine, store } = build();
    const { taskId } = await engine.createTask();
    const handle = engine.handle(taskId);

    const parked = handle.requestInput({ a: SAMPLING });
    await untilParked(engine, taskId);
    await engine.updateTask(taskId, { a: samplingResponse() });
    await parked;
    await handle.complete({});

    expect((await store.get(taskId))!.usedInputKeys).toContain("a");
  });

  it("rejects anything that is not one of MCP's three requests", async () => {
    const { engine } = build();
    const { taskId } = await engine.createTask();
    const handle = engine.handle(taskId);

    await expect(
      handle.requestInput({
        a: { method: "tools/call" } as unknown as InputRequest,
      }),
    ).rejects.toBeInstanceOf(TypeError);
    // The rejected registration must not have parked the task.
    expect((await engine.getTask(taskId)).status).toBe("working");
  });

  it("rejects an elicitation request without its required params", async () => {
    const { engine } = build();
    const { taskId } = await engine.createTask();

    await expect(
      engine.handle(taskId).requestInput({
        a: { method: "elicitation/create" } as InputRequest,
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect((await engine.getTask(taskId)).status).toBe("working");
  });

  it("rejects a sampling request without maxTokens", async () => {
    const { engine } = build();
    const { taskId } = await engine.createTask();

    await expect(
      engine.handle(taskId).requestInput({
        a: {
          method: "sampling/createMessage",
          params: { messages: [] },
        } as unknown as InputRequest,
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect((await engine.getTask(taskId)).status).toBe("working");
  });

  it("rejects malformed sampling content before parking the task", async () => {
    const { engine } = build();
    const { taskId } = await engine.createTask();

    await expect(
      engine.handle(taskId).requestInput({
        a: {
          method: "sampling/createMessage",
          params: {
            messages: [{ role: "user", content: {} }],
            maxTokens: 16,
          },
        } as unknown as InputRequest,
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect((await engine.getTask(taskId)).status).toBe("working");
  });

  it("rejects malformed sampling response content without settling the round", async () => {
    const { engine } = build();
    const { taskId } = await engine.createTask();
    const parked = engine.handle(taskId).requestInput({ a: SAMPLING });
    await untilParked(engine, taskId);

    await expect(
      engine.updateTask(taskId, {
        a: { model: "m", role: "assistant", content: {} },
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect((await engine.getTask(taskId)).status).toBe("input_required");

    await engine.updateTask(taskId, { a: samplingResponse() });
    await parked;
  });

  it("accepts every sampling content-block shape carried by MCP", async () => {
    const { engine } = build();
    const { taskId } = await engine.createTask();
    const request = {
      method: "sampling/createMessage" as const,
      params: {
        messages: [
          {
            role: "user" as const,
            content: [
              { type: "text" as const, text: "hello" },
              {
                type: "image" as const,
                data: "aW1hZ2U=",
                mimeType: "image/png",
              },
              {
                type: "audio" as const,
                data: "YXVkaW8=",
                mimeType: "audio/wav",
              },
              {
                type: "tool_use" as const,
                id: "call-1",
                name: "weather",
                input: { city: "Madrid" },
              },
              {
                type: "tool_result" as const,
                toolUseId: "call-0",
                content: [
                  {
                    type: "resource_link" as const,
                    name: "forecast",
                    uri: "file:///forecast.txt",
                  },
                  {
                    type: "resource" as const,
                    resource: {
                      uri: "file:///forecast.txt",
                      text: "sunny",
                    },
                  },
                ],
              },
            ],
          },
        ],
        maxTokens: 128,
      },
    };
    const parked = engine.handle(taskId).requestInput({ a: request });
    await untilParked(engine, taskId);

    const response = {
      model: "test-model",
      role: "assistant" as const,
      content: {
        type: "tool_result" as const,
        toolUseId: "call-1",
        content: [{ type: "text" as const, text: "22 C" }],
        structuredContent: { celsius: 22 },
      },
    };
    await engine.updateTask(taskId, { a: response });
    await expect(parked).resolves.toEqual({ a: response });
  });

  it("rejects nested elicitation schemas before parking", async () => {
    const { engine } = build();
    const { taskId } = await engine.createTask();

    await expect(
      engine.handle(taskId).requestInput({
        a: {
          method: "elicitation/create",
          params: {
            message: "Nested?",
            requestedSchema: {
              type: "object",
              properties: { nested: { type: "object" } },
            },
          },
        } as unknown as InputRequest,
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect((await engine.getTask(taskId)).status).toBe("working");
  });

  it("rejects non-primitive elicitation content without settling the round", async () => {
    const { engine } = build();
    const { taskId } = await engine.createTask();
    const parked = engine.handle(taskId).requestInput({ a: ELICIT });
    await untilParked(engine, taskId);

    await expect(
      engine.updateTask(taskId, {
        a: { action: "accept", content: { x: { nested: true } } },
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect((await engine.getTask(taskId)).status).toBe("input_required");

    await engine.updateTask(taskId, {
      a: { action: "accept", content: { x: ["one", "two"] } },
    });
    await parked;
  });
});

describe("argument checking", () => {
  it.each([
    ["completion result", "complete"],
    ["failure error", "fail"],
  ] as const)("canonicalises signed zero in a %s", async (_name, method) => {
    const { engine, store } = build();
    const { taskId } = await engine.createTask();
    const payload = { nested: { signedZero: -0 } };

    await engine.handle(taskId)[method](payload);
    const record = (await store.get(taskId))!;
    const stored = method === "complete" ? record.result : record.error;
    expect(
      Object.is(
        (stored as { nested: { signedZero: number } }).nested.signedZero,
        0,
      ),
    ).toBe(true);
  });

  it("refuses an empty requestInput", async () => {
    const { engine } = build();
    const { taskId } = await engine.createTask();
    await expect(engine.handle(taskId).requestInput({})).rejects.toBeInstanceOf(
      TypeError,
    );
  });

  // The schema types both fields as `type: "object"`. Catching it at the call
  // beats surfacing it at the far end of somebody's poll.
  it.each([[42], ["text"], [null], [[1, 2]]])(
    "refuses %j as a completion result",
    async (bad) => {
      const { engine } = build();
      const { taskId } = await engine.createTask();
      await expect(
        engine.handle(taskId).complete(bad as never),
      ).rejects.toBeInstanceOf(TypeError);
    },
  );

  it("refuses a non-object failure payload", async () => {
    const { engine } = build();
    const { taskId } = await engine.createTask();
    await expect(
      engine.handle(taskId).fail("nope" as never),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it.each([
    ["Map", { payload: new Map([["answer", 42]]) }],
    ["Date", { payload: new Date("2026-01-01T00:00:00.000Z") }],
    ["undefined", { payload: undefined }],
    ["non-finite number", { payload: Number.NaN }],
  ])("refuses a %s nested inside a completion result", async (_name, bad) => {
    const { engine } = build();
    const { taskId } = await engine.createTask();

    await expect(
      engine.handle(taskId).complete(bad as never),
    ).rejects.toBeInstanceOf(TypeError);
    expect((await engine.getTask(taskId)).status).toBe("working");
    await engine.close();
  });

  it("refuses cyclic failure payloads", async () => {
    const { engine } = build();
    const { taskId } = await engine.createTask();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    await expect(
      engine.handle(taskId).fail(cyclic as never),
    ).rejects.toBeInstanceOf(TypeError);
    expect((await engine.getTask(taskId)).status).toBe("working");
    await engine.close();
  });
});

describe("cancellation", () => {
  it("raises the signal without changing the status", async () => {
    const { engine } = build();
    const { taskId } = await engine.createTask();
    const handle = engine.handle(taskId);

    await engine.cancelTask(taskId);

    expect(handle.signal.aborted).toBe(true);
    expect(handle.signal.reason).toBeInstanceOf(TaskCancelled);
    expect((await engine.getTask(taskId)).status).toBe("working");
  });

  it("lets a task that finished first complete anyway", async () => {
    const { engine } = build();
    const { taskId } = await engine.createTask();
    const handle = engine.handle(taskId);

    await engine.cancelTask(taskId);
    await handle.complete({ raced: true });

    expect((await engine.getTask(taskId)).status).toBe("completed");
  });

  it("wakes a worker parked on input", async () => {
    const { engine } = build();
    const { taskId } = await engine.createTask();
    const handle = engine.handle(taskId);

    const parked = handle.requestInput({ a: SAMPLING });
    await untilParked(engine, taskId);
    await engine.cancelTask(taskId);

    await expect(parked).rejects.toBeInstanceOf(TaskCancelled);
  });

  it("is a no-op on an already terminal task", async () => {
    const { engine } = build();
    const { taskId } = await engine.createTask();
    await engine.handle(taskId).complete({});
    await expect(engine.cancelTask(taskId)).resolves.toEqual({
      resultType: "complete",
    });
    expect(engine.handle(taskId).signal.aborted).toBe(false);
  });
});

describe("TTL", () => {
  it("rejects a zero TTL instead of acknowledging an unreadable task", async () => {
    const { engine } = build();

    await expect(engine.createTask({ ttlMs: 0 })).rejects.toBeInstanceOf(
      TypeError,
    );
  });

  it("rejects an invalid TTL update without changing the task", async () => {
    const { engine } = build();
    const { taskId } = await engine.createTask({ ttlMs: 1000 });

    await expect(
      engine.handle(taskId).progress("bad", { ttlMs: 0 }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(engine.getTask(taskId)).resolves.toMatchObject({
      ttlMs: 1000,
    });
  });

  it("rejects a parked worker when its task expires", async () => {
    const time = clock();
    const store = new MemoryTaskStore({ now: time.now });
    const engine = new TaskLifecycle({
      store,
      now: time.now,
      sweepIntervalMs: null,
    });
    const { taskId } = await engine.createTask({ ttlMs: 20 });
    const parked = engine.handle(taskId).requestInput({ a: ROOTS });
    const rejection = expect(parked).rejects.toBeInstanceOf(TaskNotFoundError);
    await untilParked(engine, taskId);

    time.advance(20);
    await rejection;
    await engine.close();
  });

  it("expires from createdAt, and get() then reports the task as gone", async () => {
    const { engine, time } = build();
    const { taskId } = await engine.createTask({ ttlMs: 1000 });

    time.advance(999);
    await expect(engine.getTask(taskId)).resolves.toBeDefined();

    time.advance(1);
    await expect(engine.getTask(taskId)).rejects.toBeInstanceOf(
      TaskNotFoundError,
    );
  });

  it("measures a raised TTL from createdAt too, not from the change", async () => {
    const { engine, time } = build();
    const { taskId } = await engine.createTask({ ttlMs: 1000 });

    time.advance(500);
    await engine.handle(taskId).progress("extending", { ttlMs: 2000 });

    // 1500ms in: inside the extended window measured from creation.
    time.advance(1000);
    await expect(engine.getTask(taskId)).resolves.toBeDefined();

    // 2000ms in: the window closes, even though the change was made at 500.
    time.advance(500);
    await expect(engine.getTask(taskId)).rejects.toBeInstanceOf(
      TaskNotFoundError,
    );
  });

  it("makes a task unlimited when ttlMs becomes null", async () => {
    const { engine, time } = build();
    const { taskId } = await engine.createTask({ ttlMs: 1000 });

    time.advance(500);
    await engine.handle(taskId).progress("forever", { ttlMs: null });

    time.advance(10_000_000);
    await expect(engine.getTask(taskId)).resolves.toBeDefined();
  });

  it("counts swept tasks without returning any payload (I7)", async () => {
    const { engine, store, time } = build();
    await engine.createTask({ ttlMs: 1000 });
    await engine.createTask({ ttlMs: 1000 });
    await engine.createTask({ ttlMs: null });

    time.advance(1000);
    const removed = await store.sweep(time.now());
    expect(removed).toBe(2);
    expect(typeof removed).toBe("number");
  });
});

describe("compare-and-swap", () => {
  it("retries a lost race and eventually lands the write", async () => {
    const inner = new MemoryTaskStore();
    let interfere = true;
    const store: TaskStore = {
      create: (r) => inner.create(r),
      get: (id) => inner.get(id),
      async update(id, patch, version) {
        if (interfere) {
          interfere = false;
          // Simulate another writer winning by bumping the version first.
          await inner.update(id, { statusMessage: "someone else" }, version);
          throw new ConcurrentUpdateError(id, version, version + 1);
        }
        return inner.update(id, patch, version);
      },
      sweep: (n) => inner.sweep(n),
      close: () => inner.close(),
    };

    const engine = new TaskLifecycle({ store, sweepIntervalMs: null });
    const { taskId } = await engine.createTask();
    await engine.handle(taskId).progress("mine");

    expect((await engine.getTask(taskId)).statusMessage).toBe("mine");
    await engine.close();
  });

  it("retries a CAS error created by another package copy", async () => {
    const inner = new MemoryTaskStore();
    let interfere = true;
    const store: TaskStore = {
      create: (record) => inner.create(record),
      get: (id) => inner.get(id),
      async update(id, patch, version) {
        if (interfere) {
          interfere = false;
          await inner.update(id, { statusMessage: "foreign writer" }, version);
          const conflict = new Error("foreign package copy");
          conflict.name = "ConcurrentUpdateError";
          throw conflict;
        }
        return inner.update(id, patch, version);
      },
      sweep: (now) => inner.sweep(now),
      close: () => inner.close(),
    };
    const engine = new TaskLifecycle({ store, sweepIntervalMs: null });
    const { taskId } = await engine.createTask();

    await engine.handle(taskId).progress("mine");

    expect((await engine.getTask(taskId)).statusMessage).toBe("mine");
    await engine.close();
  });

  it("gives up with ConcurrentUpdateError rather than spinning forever", async () => {
    const inner = new MemoryTaskStore();
    const store: TaskStore = {
      create: (r) => inner.create(r),
      get: (id) => inner.get(id),
      update: (id, _patch, version) => {
        throw new ConcurrentUpdateError(id, version, version + 99);
      },
      sweep: (n) => inner.sweep(n),
      close: () => inner.close(),
    };

    const engine = new TaskLifecycle({ store, sweepIntervalMs: null });
    const { taskId } = await engine.createTask();

    await expect(engine.handle(taskId).progress("x")).rejects.toBeInstanceOf(
      ConcurrentUpdateError,
    );
    await engine.close();
  });

  it("does not settle input from a candidate that lost its CAS", async () => {
    const inner = new MemoryTaskStore();
    let hijack: (() => Promise<void>) | undefined;
    const store: TaskStore = {
      create: (record) => inner.create(record),
      get: (id) => inner.get(id),
      async update(id, patch, version) {
        if (hijack !== undefined) {
          const run = hijack;
          hijack = undefined;
          await run();
        }
        return inner.update(id, patch, version);
      },
      sweep: (now) => inner.sweep(now),
      close: () => inner.close(),
    };
    const engine = new TaskLifecycle({ store, sweepIntervalMs: null });
    const { taskId } = await engine.createTask();
    const handle = engine.handle(taskId);
    const parked = handle.requestInput({ a: ROOTS });
    await untilParked(engine, taskId);

    hijack = () => handle.complete({ raced: true });
    await engine.updateTask(taskId, { a: rootsResponse() });

    expect((await engine.getTask(taskId)).status).toBe("completed");
    const outcome = await Promise.race([
      parked.then(
        () => "resolved",
        () => "rejected",
      ),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 25)),
    ]);
    expect(outcome).not.toBe("resolved");
    await engine.close();
  });
});

describe("close", () => {
  it("wakes parked workers instead of leaving them hanging", async () => {
    const { engine } = build();
    const { taskId } = await engine.createTask();
    const parked = engine.handle(taskId).requestInput({ a: SAMPLING });
    await untilParked(engine, taskId);

    await engine.close();
    await expect(parked).rejects.toThrow(/closed/i);
  });

  it("is idempotent", async () => {
    const { engine } = build();
    await engine.close();
    await expect(engine.close()).resolves.toBeUndefined();
  });
});

describe("the sweeper timer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    return () => vi.useRealTimers();
  });

  it("does not hold the process open", async () => {
    const store = new MemoryTaskStore();
    const engine = new TaskLifecycle({ store, sweepIntervalMs: 50 });
    const timers = vi.getTimerCount();
    expect(timers).toBeGreaterThan(0);
    await engine.close();
    expect(vi.getTimerCount()).toBe(0);
  });
});
