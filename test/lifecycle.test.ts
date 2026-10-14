import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  type TaskError,
  type TaskHandle,
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

  describe("a stored record whose status is not one of the five", () => {
    async function withUnknownStatus() {
      const store = new MemoryTaskStore();
      await store.create({
        taskId: "odd",
        status: "submitted",
        createdAt: "2026-08-09T12:00:00.000Z",
        lastUpdatedAt: "2026-08-09T12:00:00.000Z",
        ttlMs: null,
        version: 0,
      } as unknown as TaskRecord);
      const engine = new TaskLifecycle({ store, sweepIntervalMs: null });
      return { store, engine };
    }

    it("is reported as corrupt by getTask instead of resolving undefined", async () => {
      const { engine } = await withUnknownStatus();
      await expect(engine.getTask("odd")).rejects.toThrow(
        /inconsistent.*unknown status "submitted"/i,
      );
      await engine.close();
    });

    it.each([
      ["complete", (h: ReturnType<TaskLifecycle["handle"]>) => h.complete({})],
      ["progress", (h: ReturnType<TaskLifecycle["handle"]>) => h.progress("x")],
      [
        "requestInput",
        (h: ReturnType<TaskLifecycle["handle"]>) =>
          h.requestInput({ a: ROOTS }),
      ],
      ["cancelled", (h: ReturnType<TaskLifecycle["handle"]>) => h.cancelled()],
    ])("cannot be mutated by %s", async (_name, write) => {
      const { store, engine } = await withUnknownStatus();
      await expect(write(engine.handle("odd"))).rejects.toThrow(
        /inconsistent/i,
      );
      expect(await store.get("odd")).toMatchObject({
        status: "submitted",
        version: 0,
      });
      await engine.close();
    });

    it("is refused by updateTask and cancelTask, raising no signal", async () => {
      const { store, engine } = await withUnknownStatus();
      const handle = engine.handle("odd");
      await expect(engine.updateTask("odd", { a: {} })).rejects.toThrow(
        /inconsistent/i,
      );
      await expect(engine.cancelTask("odd")).rejects.toThrow(/inconsistent/i);
      expect(handle.signal.aborted).toBe(false);
      expect(await store.get("odd")).toMatchObject({ version: 0 });
      await engine.close();
    });
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
    [
      "fail",
      (h: ReturnType<TaskLifecycle["handle"]>) =>
        h.fail({ code: -1, message: "boom" }),
    ],
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

// After a restart nothing in the new process waits on the round a dead worker
// opened. A client reply that completes it is retained, off the wire, until a
// worker claims it with resumeInput(); the task moves to working as before.
describe("input responses that arrive with no worker", () => {
  /** A task parked by a process that is gone: no waiter here. */
  async function orphanedRound(
    requests: Record<string, InputRequest> = { a: ROOTS, b: ROOTS },
  ) {
    const store = new MemoryTaskStore();
    const stamp = new Date().toISOString();
    await store.create({
      taskId: "t",
      status: "input_required",
      createdAt: stamp,
      lastUpdatedAt: stamp,
      ttlMs: null,
      inputRequests: requests,
      inputResponses: {},
      usedInputKeys: ["older", ...Object.keys(requests)],
      version: 3,
    });
    const engine = new TaskLifecycle({ store, sweepIntervalMs: null });
    return { store, engine, handle: engine.handle("t") };
  }

  it("retains a completing reply, moves the task to working, and keeps it off the wire", async () => {
    const { store, engine } = await orphanedRound();
    await expect(
      engine.updateTask("t", { a: rootsResponse(), b: rootsResponse() }),
    ).resolves.toEqual({ resultType: "complete" });

    const record = await store.get("t");
    expect(record).toMatchObject({
      status: "working",
      unclaimedInputResponses: { a: { roots: [] }, b: { roots: [] } },
      usedInputKeys: ["older", "a", "b"],
      version: 4,
    });
    expect(record).not.toHaveProperty("inputRequests");
    expect(record).not.toHaveProperty("inputResponses");
    const view = await engine.getTask("t");
    expect(view.status).toBe("working");
    expect(view).not.toHaveProperty("unclaimedInputResponses");
    await engine.close();
  });

  it("retains every answer of a round completed across several partial updates", async () => {
    const { store, engine } = await orphanedRound();
    await engine.updateTask("t", { a: rootsResponse() });
    expect(await store.get("t")).not.toHaveProperty("unclaimedInputResponses");
    await engine.updateTask("t", { b: rootsResponse(), ghost: {} });
    expect((await store.get("t"))?.unclaimedInputResponses).toEqual({
      a: { roots: [] },
      b: { roots: [] },
    });
    await engine.close();
  });

  it("is claimed by resumeInput() exactly once", async () => {
    const { store, engine, handle } = await orphanedRound();
    await engine.updateTask("t", { a: rootsResponse(), b: rootsResponse() });

    const claims = await Promise.all(
      Array.from({ length: 5 }, () => engine.handle("t").resumeInput()),
    );
    const claimed = claims.filter((claim) => claim !== undefined);
    expect(claimed).toEqual([{ a: { roots: [] }, b: { roots: [] } }]);
    await expect(handle.resumeInput()).resolves.toBeUndefined();
    const record = await store.get("t");
    expect(record).not.toHaveProperty("unclaimedInputResponses");
    expect(record).toMatchObject({ status: "working", version: 5 });
    await engine.close();
  });

  it("returns a copy the worker may change freely", async () => {
    const { store, engine, handle } = await orphanedRound({ a: ROOTS });
    await engine.updateTask("t", { a: rootsResponse() });
    const claimed = (await handle.resumeInput()) as Record<
      string,
      { roots: unknown[] }
    >;
    claimed.a!.roots.push("changed");
    expect(await store.get("t")).not.toHaveProperty("unclaimedInputResponses");
    await engine.close();
  });

  it("writes nothing when there is nothing to claim", async () => {
    const { store, engine } = build();
    const { taskId } = await engine.createTask();
    const update = vi.spyOn(store, "update");
    await expect(engine.handle(taskId).resumeInput()).resolves.toBeUndefined();
    expect(update).not.toHaveBeenCalled();
    await engine.close();
  });

  it("keeps the live-worker path unchanged: the waiter gets the answers and nothing is retained", async () => {
    const { store, engine } = build();
    const { taskId } = await engine.createTask();
    const handle = engine.handle(taskId);
    const answers = handle.requestInput({ a: ROOTS });
    await untilParked(engine, taskId);
    const before = await store.get(taskId);

    await engine.updateTask(taskId, { a: rootsResponse() });
    await expect(answers).resolves.toEqual({ a: { roots: [] } });
    const record = await store.get(taskId);
    expect(record).not.toHaveProperty("unclaimedInputResponses");
    expect(record?.version).toBe(before!.version + 1);
    await expect(handle.resumeInput()).resolves.toBeUndefined();
    await engine.close();
  });

  it("is cleared when the worker opens a new round, and the old keys stay spent (I5)", async () => {
    const { store, engine, handle } = await orphanedRound({ a: ROOTS });
    await engine.updateTask("t", { a: rootsResponse() });

    await expect(handle.requestInput({ a: ROOTS })).rejects.toBeInstanceOf(
      DuplicateInputKeyError,
    );
    expect((await store.get("t"))?.unclaimedInputResponses).toBeDefined();

    const next = handle.requestInput({ c: ROOTS });
    void next.catch(() => undefined);
    await untilParked(engine, "t");
    expect(await store.get("t")).not.toHaveProperty("unclaimedInputResponses");
    await engine.close();
  });

  it.each([
    ["complete()", (h: TaskHandle) => h.complete({ ok: true })],
    ["fail()", (h: TaskHandle) => h.fail({ code: -32000, message: "m" })],
    ["cancelled()", (h: TaskHandle) => h.cancelled()],
  ])("is cleared by %s", async (_name, finish) => {
    const { store, engine, handle } = await orphanedRound({ a: ROOTS });
    await engine.updateTask("t", { a: rootsResponse() });
    await finish(handle);
    expect(await store.get("t")).not.toHaveProperty("unclaimedInputResponses");
    await expect(handle.resumeInput()).rejects.toBeInstanceOf(
      TaskAlreadyTerminalError,
    );
    await engine.close();
  });

  it("survives progress(), which does not touch it", async () => {
    const { store, engine, handle } = await orphanedRound({ a: ROOTS });
    await engine.updateTask("t", { a: rootsResponse() });
    await handle.progress("restarted");
    expect((await store.get("t"))?.unclaimedInputResponses).toEqual({
      a: { roots: [] },
    });
    await engine.close();
  });

  it("throws TaskNotFoundError for a task that does not exist", async () => {
    const { engine } = build();
    await expect(engine.handle("nope").resumeInput()).rejects.toBeInstanceOf(
      TaskNotFoundError,
    );
    await engine.close();
  });

  it("never hands one round's answers to a worker waiting on a newer round", async () => {
    const { store, engine, handle } = await orphanedRound({ a: ROOTS });
    // The client's answer to the old round and the worker's new round race.
    const update = engine.updateTask("t", { a: rootsResponse() });
    const next = handle.requestInput({ c: ROOTS });
    const settled = vi.fn();
    next.then(settled, settled);
    await update;
    await untilParked(engine, "t");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(settled).not.toHaveBeenCalled();
    expect(await store.get("t")).toMatchObject({
      status: "input_required",
      inputRequests: { c: ROOTS },
    });
    await engine.updateTask("t", { c: rootsResponse() });
    await expect(next).resolves.toEqual({ c: { roots: [] } });
    await engine.close();
  });
});

describe("argument checking", () => {
  it.each([
    ["completion result", "complete"],
    ["failure error", "fail"],
  ] as const)("canonicalises signed zero in a %s", async (_name, method) => {
    const { engine, store } = build();
    const { taskId } = await engine.createTask();
    // A valid JSON-RPC error too, so the same payload suits fail().
    const payload = { code: -32000, message: "m", nested: { signedZero: -0 } };

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

  // The stable schema types a failed task's `error` as a JSON-RPC error:
  // integer `code`, string `message`, optional `data`. Anything else would be
  // stored and then emitted on every tasks/get as a result the schema rejects.
  it.each<[string, unknown]>([
    ["an empty object", {}],
    ["an object without code or message", { reason: "x" }],
    ["a missing message", { code: -32000 }],
    ["a missing code", { message: "boom" }],
    ["a fractional code", { code: 1.5, message: "boom" }],
    ["a numeric-string code", { code: "-32000", message: "boom" }],
    ["a null code", { code: null, message: "boom" }],
    ["a non-string message", { code: -32000, message: 42 }],
    ["a null message", { code: -32000, message: null }],
  ])("fail() refuses %s and stores nothing", async (_name, error) => {
    const store = new MemoryTaskStore();
    const engine = new TaskLifecycle({ store, sweepIntervalMs: null });
    const { taskId } = await engine.createTask();
    const before = await engine.getTask(taskId);
    const update = vi.spyOn(store, "update");

    await expect(engine.handle(taskId).fail(error as never)).rejects.toThrow(
      /fail\(\) error must be a JSON-RPC error object with an integer code and a string message/,
    );
    await expect(
      engine.handle(taskId).fail(error as never),
    ).rejects.toBeInstanceOf(TypeError);
    expect(update).not.toHaveBeenCalled();
    await expect(engine.getTask(taskId)).resolves.toEqual(before);
    await engine.close();
  });

  it.each<[string, Record<string, unknown>]>([
    ["code and message only", { code: -32603, message: "boom" }],
    ["object data", { code: 1, message: "m", data: { attempt: 1 } }],
    ["scalar data", { code: 0, message: "", data: "detail" }],
    ["null data", { code: -1, message: "m", data: null }],
    ["an extra member", { code: -32000, message: "m", retryable: false }],
    [
      "a code at the edge of the safe range",
      { code: Number.MIN_SAFE_INTEGER, message: "m" },
    ],
  ])("fail() accepts a JSON-RPC error with %s", async (_name, error) => {
    const { engine } = build();
    const { taskId } = await engine.createTask();
    await engine.handle(taskId).fail(error as never);
    await expect(engine.getTask(taskId)).resolves.toMatchObject({
      status: "failed",
      error,
    });
    await engine.close();
  });

  // The parameter type says what the runtime check enforces, so `tsc` (run by
  // `pnpm lint`) catches a looser object before it reaches the engine.
  it("types fail()'s parameter as a JSON-RPC error", async () => {
    const { engine } = build();
    const { taskId } = await engine.createTask();
    const handle = engine.handle(taskId);
    const valid: TaskError = { code: -32000, message: "m", data: [1, "x"] };

    const refused = [
      // @ts-expect-error -- no code or message
      () => handle.fail({ reason: "x" }),
      // @ts-expect-error -- missing message
      () => handle.fail({ code: 1 }),
      // @ts-expect-error -- message must be a string
      () => handle.fail({ code: 1, message: 2 }),
      // @ts-expect-error -- data must be JSON
      () => handle.fail({ code: 1, message: "m", data: new Date() }),
    ];
    for (const call of refused) {
      await expect(call()).rejects.toBeInstanceOf(TypeError);
    }
    await handle.fail(valid);
    await expect(engine.getTask(taskId)).resolves.toMatchObject({
      error: valid,
    });
    await engine.close();
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

  it("does not keep a signal for a task with no local worker past its expiry", async () => {
    vi.useFakeTimers();
    try {
      const { engine, store, time } = build();
      const ids: string[] = [];
      for (let index = 0; index < 50; index += 1) {
        const { taskId } = await engine.createTask({ ttlMs: 1_000 });
        await engine.cancelTask(taskId);
        ids.push(taskId);
      }

      time.advance(1_000);
      vi.advanceTimersByTime(1_000);
      await store.sweep(time.now());

      // The aborted controller that cancelTask created is gone: a handle for
      // the same id now reads a fresh signal, not the TaskCancelled one (its
      // lookup later aborts it as not found, since the task is gone).
      for (const taskId of ids) {
        expect(engine.handle(taskId).signal.aborted).toBe(false);
      }
      await engine.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still raises the signal for a worker that reads it after the cancel", async () => {
    vi.useFakeTimers();
    try {
      const { engine, time } = build();
      const { taskId } = await engine.createTask({ ttlMs: 1_000 });
      await engine.cancelTask(taskId);

      time.advance(999);
      vi.advanceTimersByTime(999);
      expect(engine.handle(taskId).signal.aborted).toBe(true);
      await engine.close();
    } finally {
      vi.useRealTimers();
    }
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

// TTL bounds how long the task is exposed; stopping the work is the server's
// policy. This engine's policy is cooperative: a worker holding the signal is
// told, with the TaskNotFoundError the task now reads as. Nothing is written.
describe("the worker signal at TTL expiry", () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);

  beforeEach(() => {
    unhandled.length = 0;
    process.on("unhandledRejection", onUnhandled);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    process.off("unhandledRejection", onUnhandled);
  });

  async function elapse(time: ReturnType<typeof clock>, ms: number) {
    time.advance(ms);
    await vi.advanceTimersByTimeAsync(ms);
  }

  it("aborts a held signal with TaskNotFoundError, and the task reads as not found", async () => {
    const { engine, store, time } = build();
    const { taskId } = await engine.createTask({ ttlMs: 1_000 });
    const signal = engine.handle(taskId).signal;
    const update = vi.spyOn(store, "update");

    await elapse(time, 999);
    expect(signal.aborted).toBe(false);

    await elapse(time, 1);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBeInstanceOf(TaskNotFoundError);
    await expect(engine.getTask(taskId)).rejects.toBeInstanceOf(
      TaskNotFoundError,
    );
    expect(update).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
    await engine.close();
  });

  it("never aborts the signal of a task with ttlMs null", async () => {
    const { engine, time } = build();
    const { taskId } = await engine.createTask({ ttlMs: null });
    const signal = engine.handle(taskId).signal;

    await elapse(time, 10 * 3_600_000);
    expect(signal.aborted).toBe(false);
    await engine.close();
  });

  it("re-arms when progress() extends the TTL, and does not abort at the old expiry", async () => {
    const { engine, time } = build();
    const { taskId } = await engine.createTask({ ttlMs: 1_000 });
    const handle = engine.handle(taskId);
    const signal = handle.signal;

    await elapse(time, 500);
    await handle.progress("extending", { ttlMs: 3_000 });

    await elapse(time, 500);
    expect(signal.aborted).toBe(false);
    await expect(engine.getTask(taskId)).resolves.toBeDefined();

    await elapse(time, 2_000);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBeInstanceOf(TaskNotFoundError);
    await engine.close();
  });

  it("rejects a worker parked in requestInput exactly once, and aborts its signal", async () => {
    const { engine, time } = build();
    const { taskId } = await engine.createTask({ ttlMs: 1_000 });
    const handle = engine.handle(taskId);
    const parked = handle.requestInput({ a: ROOTS });
    const signal = handle.signal;
    const settled = vi.fn();
    parked.then(settled, settled);
    await vi.advanceTimersByTimeAsync(0);
    expect((await engine.getTask(taskId)).status).toBe("input_required");

    await elapse(time, 1_000);
    await expect(parked).rejects.toBeInstanceOf(TaskNotFoundError);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe(settled.mock.calls[0]![0]);

    // Expiry released the controller. Reading the signal again yields a new
    // one, which is aborted as soon as its lookup finds the task gone.
    const reread = handle.signal;
    await vi.advanceTimersByTimeAsync(0);
    expect(reread.reason).toBeInstanceOf(TaskNotFoundError);

    // A late answer finds no task and wakes nothing a second time.
    await expect(
      engine.updateTask(taskId, { a: rootsResponse() }),
    ).rejects.toBeInstanceOf(TaskNotFoundError);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(unhandled).toEqual([]);
    await engine.close();
  });

  it("keeps TaskCancelled as the reason when the task was cancelled first", async () => {
    const { engine, time } = build();
    const { taskId } = await engine.createTask({ ttlMs: 1_000 });
    const signal = engine.handle(taskId).signal;
    await engine.cancelTask(taskId);

    await elapse(time, 1_000);
    expect(signal.reason).toBeInstanceOf(TaskCancelled);
    await engine.close();
  });

  it("aborts the signal when a worker's write finds the task already gone", async () => {
    // The store's clock is ahead of the lifecycle's, so the write sees the
    // expiry before the lifecycle's own timer does.
    const time = clock();
    const storeTime = clock();
    const store = new MemoryTaskStore({ now: storeTime.now });
    const engine = new TaskLifecycle({
      store,
      now: time.now,
      sweepIntervalMs: null,
    });
    const { taskId } = await engine.createTask({ ttlMs: 1_000 });
    const handle = engine.handle(taskId);
    const signal = handle.signal;
    await vi.advanceTimersByTimeAsync(0);

    storeTime.advance(1_000);
    await expect(handle.progress("late")).rejects.toBeInstanceOf(
      TaskNotFoundError,
    );
    expect(signal.reason).toBeInstanceOf(TaskNotFoundError);
    await engine.close();
  });
});

describe("integer milliseconds", () => {
  // The stable schema types both hints as integers in the safe-integer range.
  // Anything else would be stored and then emitted on every tasks/get.
  const NOT_SAFE_INTEGERS: [string, unknown][] = [
    ["a fraction", 1.5],
    ["one past the safe range", Number.MAX_SAFE_INTEGER + 1],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a numeric string", "1000"],
  ];

  it.each(NOT_SAFE_INTEGERS)(
    "createTask() refuses %s as ttlMs and stores nothing",
    async (_name, ttlMs) => {
      const store = new MemoryTaskStore();
      const create = vi.spyOn(store, "create");
      const engine = new TaskLifecycle({ store, sweepIntervalMs: null });
      await expect(
        engine.createTask({ ttlMs: ttlMs as number }),
      ).rejects.toThrow(/createTask\(\) ttlMs must be null or a safe integer/);
      expect(create).not.toHaveBeenCalled();
      await engine.close();
    },
  );

  it.each([...NOT_SAFE_INTEGERS, ["a negative fraction", -0.5]])(
    "createTask() refuses %s as pollIntervalMs and stores nothing",
    async (_name, pollIntervalMs) => {
      const store = new MemoryTaskStore();
      const create = vi.spyOn(store, "create");
      const engine = new TaskLifecycle({ store, sweepIntervalMs: null });
      await expect(
        engine.createTask({ pollIntervalMs: pollIntervalMs as number }),
      ).rejects.toThrow(/createTask\(\) pollIntervalMs must be a safe integer/);
      expect(create).not.toHaveBeenCalled();
      await engine.close();
    },
  );

  it.each(NOT_SAFE_INTEGERS)(
    "progress() refuses %s as ttlMs or pollIntervalMs without changing the task",
    async (_name, value) => {
      const { engine } = build();
      const { taskId } = await engine.createTask({
        ttlMs: 1000,
        pollIntervalMs: 500,
      });
      const before = await engine.getTask(taskId);
      const handle = engine.handle(taskId);

      await expect(
        handle.progress("bad", { ttlMs: value as number }),
      ).rejects.toThrow(/progress\(\) ttlMs must be null or a safe integer/);
      await expect(
        handle.progress("bad", { pollIntervalMs: value as number }),
      ).rejects.toThrow(/progress\(\) pollIntervalMs must be a safe integer/);
      // A bad hint rejects the whole call: the message is not applied either.
      await expect(
        handle.progress("bad", {
          ttlMs: 2000,
          pollIntervalMs: value as number,
        }),
      ).rejects.toBeInstanceOf(TypeError);

      await expect(engine.getTask(taskId)).resolves.toEqual(before);
    },
  );

  it("accepts the boundary values of the safe-integer range", async () => {
    const { engine } = build();
    const created = await engine.createTask({
      ttlMs: Number.MAX_SAFE_INTEGER,
      pollIntervalMs: Number.MAX_SAFE_INTEGER,
    });
    expect(created).toMatchObject({
      ttlMs: Number.MAX_SAFE_INTEGER,
      pollIntervalMs: Number.MAX_SAFE_INTEGER,
    });

    // The smallest TTL is 1 ms (0 is refused separately); a zero polling hint
    // is an integer the schema accepts, so it is not refused here.
    const { taskId } = await engine.createTask({ ttlMs: 1, pollIntervalMs: 0 });
    await engine.handle(taskId).progress("revised", {
      ttlMs: Number.MAX_SAFE_INTEGER,
      pollIntervalMs: 0,
    });
    await expect(engine.getTask(taskId)).resolves.toMatchObject({
      ttlMs: Number.MAX_SAFE_INTEGER,
      pollIntervalMs: 0,
    });
  });

  it.each([
    ["defaultTtlMs", { defaultTtlMs: 1.5 }, /defaultTtlMs must be null/],
    [
      "defaultTtlMs",
      { defaultTtlMs: Number.MAX_SAFE_INTEGER + 1 },
      /defaultTtlMs must be null/,
    ],
    [
      "defaultPollIntervalMs",
      { defaultPollIntervalMs: 0.5 },
      /defaultPollIntervalMs must be a safe integer/,
    ],
    [
      "defaultPollIntervalMs",
      { defaultPollIntervalMs: Number.NaN },
      /defaultPollIntervalMs must be a safe integer/,
    ],
  ])("the constructor refuses a non-integer %s", (_name, options, message) => {
    expect(
      () =>
        new TaskLifecycle({
          store: new MemoryTaskStore(),
          sweepIntervalMs: null,
          ...options,
        }),
    ).toThrow(message);
  });
});

describe("statusMessage is a string at runtime", () => {
  // Unreachable from typed TypeScript, reachable from JavaScript. Every path
  // that writes a statusMessage refuses a non-string before the store sees it.
  const NOT_STRINGS: [string, unknown][] = [
    ["a number", 42],
    ["null", null],
    ["an object", { text: "x" }],
    ["an array", ["x"]],
  ];

  it.each(NOT_STRINGS)(
    "progress() refuses %s without changing the task",
    async (_name, value) => {
      const { engine } = build();
      const { taskId } = await engine.createTask({ statusMessage: "queued" });
      const before = await engine.getTask(taskId);
      await expect(
        engine.handle(taskId).progress(value as string),
      ).rejects.toThrow(/progress\(\) statusMessage must be a string/);
      await expect(engine.getTask(taskId)).resolves.toEqual(before);
    },
  );

  it.each(NOT_STRINGS)(
    "createTask() refuses %s and stores nothing",
    async (_name, value) => {
      const store = new MemoryTaskStore();
      const create = vi.spyOn(store, "create");
      const engine = new TaskLifecycle({ store, sweepIntervalMs: null });
      await expect(
        engine.createTask({ statusMessage: value as string }),
      ).rejects.toThrow(/createTask\(\) statusMessage must be a string/);
      expect(create).not.toHaveBeenCalled();
      await engine.close();
    },
  );

  it.each(NOT_STRINGS)(
    "cancelled() refuses %s and the task stays non-terminal",
    async (_name, value) => {
      const { engine } = build();
      const { taskId } = await engine.createTask();
      await expect(
        engine.handle(taskId).cancelled(value as string),
      ).rejects.toThrow(/cancelled\(\) statusMessage must be a string/);
      await expect(engine.getTask(taskId)).resolves.toMatchObject({
        status: "working",
      });
    },
  );

  it("still accepts an empty string, and cancelled() without one", async () => {
    const { engine } = build();
    const { taskId } = await engine.createTask({ statusMessage: "" });
    await engine.handle(taskId).progress("");
    await expect(engine.getTask(taskId)).resolves.toMatchObject({
      statusMessage: "",
    });
    await engine.handle(taskId).cancelled();
    await expect(engine.getTask(taskId)).resolves.toMatchObject({
      status: "cancelled",
      statusMessage: "",
    });
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

  // Node coerces each of these to a 1 ms interval (with a warning for NaN
  // and for values beyond its 32-bit timer limit), which turns housekeeping
  // into a busy sweep loop.
  it.each([
    ["zero", 0],
    ["a negative period", -5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a fraction", 1.5],
    ["a numeric string", "50"],
    ["a period beyond the timer limit", 2 ** 31],
  ])("refuses %s as sweepIntervalMs and starts no timer", (_name, value) => {
    expect(
      () =>
        new TaskLifecycle({
          store: new MemoryTaskStore(),
          sweepIntervalMs: value as number,
        }),
    ).toThrow(TypeError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["1 ms", 1],
    ["the timer limit", 2 ** 31 - 1],
  ])("accepts %s as sweepIntervalMs", async (_name, value) => {
    const engine = new TaskLifecycle({
      store: new MemoryTaskStore(),
      sweepIntervalMs: value,
    });
    expect(vi.getTimerCount()).toBe(value == null ? 0 : 1);
    await engine.close();
  });
});
