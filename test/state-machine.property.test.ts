import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  MemoryTaskStore,
  TaskLifecycle,
  type InputRequest,
  type InputResponses,
  type JsonObject,
  type TaskPatch,
  type TaskRecord,
  type TaskStatus,
  type TaskStore,
} from "../src/index.js";

const START = Date.parse("2026-08-10T12:00:00.000Z");
const TASK_ID = "property-task";
const ROOTS: InputRequest = { method: "roots/list" };

type Operation =
  | {
      kind: "progress";
      message: string;
      ttl: "unchanged" | "null" | "finite";
      ttlMs: number;
      pollIntervalMs: number | undefined;
    }
  | { kind: "request"; keys: string[] }
  | { kind: "respond"; mode: "none" | "partial" | "all" | "mixed" }
  | {
      kind: "finish";
      status: "completed" | "failed" | "cancelled";
      value: number;
    }
  | { kind: "cancel" }
  | { kind: "advance"; milliseconds: number }
  | { kind: "inject-conflict" }
  | { kind: "read" };

interface ReferenceModel {
  now: number;
  status: TaskStatus;
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number | null;
  pollIntervalMs?: number;
  version: number;
  usedInputKeys: string[];
  inputRequests?: Map<string, InputRequest>;
  inputResponses?: Map<string, { roots: [] }>;
  result?: JsonObject;
  error?: JsonObject;
  signalAborted: boolean;
}

interface TrackedWaiter {
  promise: Promise<InputResponses>;
  settlements: number;
  outcome?: "resolved" | "rejected";
  value?: InputResponses;
}

class ConflictInjectingStore implements TaskStore {
  readonly inner: MemoryTaskStore;
  #conflictNextUpdate = false;

  constructor(now: () => number) {
    this.inner = new MemoryTaskStore({ now });
  }

  injectConflict(): void {
    this.#conflictNextUpdate = true;
  }

  create(record: TaskRecord): Promise<void> {
    return this.inner.create(record);
  }

  get(taskId: string): Promise<TaskRecord | undefined> {
    return this.inner.get(taskId);
  }

  update(
    taskId: string,
    patch: TaskPatch,
    expectedVersion: number,
  ): Promise<TaskRecord> {
    if (this.#conflictNextUpdate) {
      this.#conflictNextUpdate = false;
      const conflict = new Error("injected foreign CAS conflict");
      conflict.name = "ConcurrentUpdateError";
      throw conflict;
    }
    return this.inner.update(taskId, patch, expectedVersion);
  }

  sweep(now?: number): Promise<number> {
    return this.inner.sweep(now);
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}

const keyArbitrary = fc.oneof(
  fc.constantFrom(
    "toString",
    "constructor",
    "__proto__",
    "hasOwnProperty",
    "valueOf",
  ),
  fc.string({ minLength: 0, maxLength: 8 }),
);

const operationArbitrary: fc.Arbitrary<Operation> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({
      kind: fc.constant("progress" as const),
      message: fc.string({ maxLength: 20 }),
      ttl: fc.constantFrom(
        "unchanged" as const,
        "null" as const,
        "finite" as const,
      ),
      ttlMs: fc.integer({ min: 1, max: 20_000 }),
      pollIntervalMs: fc.option(fc.integer({ min: 0, max: 5_000 }), {
        nil: undefined,
      }),
    }),
  },
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant("request" as const),
      keys: fc.array(keyArbitrary, { minLength: 1, maxLength: 4 }),
    }),
  },
  {
    weight: 5,
    arbitrary: fc.record({
      kind: fc.constant("respond" as const),
      mode: fc.constantFrom(
        "none" as const,
        "partial" as const,
        "all" as const,
        "mixed" as const,
      ),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("finish" as const),
      status: fc.constantFrom(
        "completed" as const,
        "failed" as const,
        "cancelled" as const,
      ),
      value: fc.integer(),
    }),
  },
  { weight: 2, arbitrary: fc.constant({ kind: "cancel" as const }) },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("advance" as const),
      milliseconds: fc.integer({ min: -10_000, max: 20_000 }),
    }),
  },
  { weight: 2, arbitrary: fc.constant({ kind: "inject-conflict" as const }) },
  { weight: 2, arbitrary: fc.constant({ kind: "read" as const }) },
);

function isTerminal(status: TaskStatus): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

function isVisible(model: ReferenceModel): boolean {
  return (
    model.ttlMs === null ||
    model.now < Date.parse(model.createdAt) + model.ttlMs
  );
}

function commit(model: ReferenceModel): void {
  model.version += 1;
  model.lastUpdatedAt = new Date(
    Math.max(model.now, Date.parse(model.lastUpdatedAt)),
  ).toISOString();
}

function ownRecord<T>(
  entries: Iterable<readonly [string, T]>,
): Record<string, T> {
  return Object.fromEntries(entries);
}

function expectedRecord(model: ReferenceModel): TaskRecord {
  return {
    taskId: TASK_ID,
    status: model.status,
    createdAt: model.createdAt,
    lastUpdatedAt: model.lastUpdatedAt,
    ttlMs: model.ttlMs,
    version: model.version,
    ...(model.statusMessage !== undefined && {
      statusMessage: model.statusMessage,
    }),
    ...(model.pollIntervalMs !== undefined && {
      pollIntervalMs: model.pollIntervalMs,
    }),
    ...(model.usedInputKeys.length > 0 && {
      usedInputKeys: [...model.usedInputKeys],
    }),
    ...(model.inputRequests !== undefined && {
      inputRequests: ownRecord(model.inputRequests),
    }),
    ...(model.inputResponses !== undefined && {
      inputResponses: ownRecord(model.inputResponses),
    }),
    ...(model.result !== undefined && { result: model.result }),
    ...(model.error !== undefined && { error: model.error }),
  } as TaskRecord;
}

function trackWaiter(promise: Promise<InputResponses>): TrackedWaiter {
  const tracked: TrackedWaiter = { promise, settlements: 0 };
  void promise.then(
    (value) => {
      tracked.settlements += 1;
      tracked.outcome = "resolved";
      tracked.value = value;
    },
    () => {
      tracked.settlements += 1;
      tracked.outcome = "rejected";
    },
  );
  return tracked;
}

async function flushEffects(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
}

async function waitUntilParked(engine: TaskLifecycle): Promise<void> {
  for (let turn = 0; turn < 50; turn += 1) {
    const view = await engine.getTask(TASK_ID);
    if (view.status === "input_required") return;
    await Promise.resolve();
  }
  throw new Error("property task never became input_required");
}

async function expectNamedError(
  operation: Promise<unknown>,
  names: readonly string[],
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    expect(names).toContain((error as { name?: string }).name);
    return;
  }
  throw new Error(`expected ${names.join(" or ")}, but operation resolved`);
}

async function assertState(
  model: ReferenceModel,
  engine: TaskLifecycle,
  store: ConflictInjectingStore,
  waiters: readonly TrackedWaiter[],
  activeWaiter: TrackedWaiter | undefined,
): Promise<void> {
  await flushEffects();
  for (const waiter of waiters)
    expect(waiter.settlements).toBeLessThanOrEqual(1);
  if (activeWaiter !== undefined) expect(activeWaiter.settlements).toBe(0);

  expect(new Set(model.usedInputKeys).size).toBe(model.usedInputKeys.length);
  expect(Date.parse(model.lastUpdatedAt)).toBeGreaterThanOrEqual(
    Date.parse(model.createdAt),
  );

  if (!isVisible(model)) {
    await expectNamedError(engine.getTask(TASK_ID), ["TaskNotFoundError"]);
    expect(await store.get(TASK_ID)).toBeUndefined();
    return;
  }

  const record = await store.get(TASK_ID);
  expect(record).toEqual(expectedRecord(model));

  const view = await engine.getTask(TASK_ID);
  expect(view.resultType).toBe("complete");
  expect(view.status).toBe(model.status);
  expect(view.lastUpdatedAt).toBe(model.lastUpdatedAt);
  expect(view.ttlMs).toBe(model.ttlMs);
  expect(view).not.toHaveProperty("version");
  expect(view).not.toHaveProperty("usedInputKeys");
  expect(view).not.toHaveProperty("inputResponses");

  const expectedKeys = [
    "createdAt",
    "lastUpdatedAt",
    "resultType",
    "status",
    "taskId",
    "ttlMs",
    ...(model.statusMessage === undefined ? [] : ["statusMessage"]),
    ...(model.pollIntervalMs === undefined ? [] : ["pollIntervalMs"]),
    ...(model.status === "input_required" ? ["inputRequests"] : []),
    ...(model.status === "completed" ? ["result"] : []),
    ...(model.status === "failed" ? ["error"] : []),
  ].sort();
  expect(Object.keys(view).sort()).toEqual(expectedKeys);

  if (model.status === "input_required") {
    expect(view).toMatchObject({
      inputRequests: ownRecord(model.inputRequests!),
    });
  } else if (model.status === "completed") {
    expect(view).toMatchObject({ result: model.result });
  } else if (model.status === "failed") {
    expect(view).toMatchObject({ error: model.error });
  }
}

describe("property-based task state machine", () => {
  it("preserves I2, I4, I5, exact versions, closed wire shapes and waiter effects", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.option(fc.integer({ min: 1, max: 30_000 }), { nil: null }),
        fc.array(operationArbitrary, { minLength: 1, maxLength: 60 }),
        async (initialTtlMs, operations) => {
          const model: ReferenceModel = {
            now: START,
            status: "working",
            createdAt: new Date(START).toISOString(),
            lastUpdatedAt: new Date(START).toISOString(),
            ttlMs: initialTtlMs,
            version: 0,
            usedInputKeys: [],
            signalAborted: false,
          };
          const store = new ConflictInjectingStore(() => model.now);
          const engine = new TaskLifecycle({
            store,
            now: () => model.now,
            generateTaskId: () => TASK_ID,
            defaultPollIntervalMs: null,
            sweepIntervalMs: null,
          });
          const handle = engine.handle(TASK_ID);
          const waiters: TrackedWaiter[] = [];
          let activeWaiter: TrackedWaiter | undefined;

          await engine.createTask({ ttlMs: initialTtlMs });

          try {
            await assertState(model, engine, store, waiters, activeWaiter);

            for (const operation of operations) {
              switch (operation.kind) {
                case "inject-conflict":
                  store.injectConflict();
                  break;

                case "read":
                  break;

                case "advance":
                  // Pending waiter expiry has focused timer tests. Keeping the
                  // generated clock still here avoids real-time scheduling in
                  // this pure transition model while exercising rollback and
                  // retroactive TTL on every other state.
                  if (activeWaiter === undefined) {
                    model.now += operation.milliseconds;
                  }
                  break;

                case "progress": {
                  const patch = {
                    ...(operation.pollIntervalMs !== undefined && {
                      pollIntervalMs: operation.pollIntervalMs,
                    }),
                    ...(activeWaiter === undefined && operation.ttl === "null"
                      ? { ttlMs: null }
                      : {}),
                    ...(activeWaiter === undefined && operation.ttl === "finite"
                      ? { ttlMs: operation.ttlMs }
                      : {}),
                  };
                  if (!isVisible(model)) {
                    await expectNamedError(
                      handle.progress(operation.message, patch),
                      ["TaskNotFoundError"],
                    );
                  } else if (isTerminal(model.status)) {
                    await expectNamedError(
                      handle.progress(operation.message, patch),
                      ["TaskAlreadyTerminalError"],
                    );
                  } else {
                    await handle.progress(operation.message, patch);
                    model.statusMessage = operation.message;
                    if (operation.pollIntervalMs !== undefined) {
                      model.pollIntervalMs = operation.pollIntervalMs;
                    }
                    if (
                      activeWaiter === undefined &&
                      operation.ttl === "null"
                    ) {
                      model.ttlMs = null;
                    } else if (
                      activeWaiter === undefined &&
                      operation.ttl === "finite"
                    ) {
                      model.ttlMs = operation.ttlMs;
                    }
                    commit(model);
                  }
                  break;
                }

                case "request": {
                  const candidateKeys = [...new Set(operation.keys)];
                  const requests = Object.create(null) as Record<
                    string,
                    InputRequest
                  >;
                  for (const key of candidateKeys) requests[key] = ROOTS;
                  // Integer-like own keys have JavaScript's canonical
                  // enumeration order; the lifecycle observes Object.keys too.
                  const keys = Object.keys(requests);
                  const reused = keys.find((key) =>
                    model.usedInputKeys.includes(key),
                  );

                  if (!isVisible(model)) {
                    await expectNamedError(handle.requestInput(requests), [
                      "TaskNotFoundError",
                      "TaskCancelled",
                    ]);
                  } else if (isTerminal(model.status)) {
                    await expectNamedError(handle.requestInput(requests), [
                      "TaskAlreadyTerminalError",
                    ]);
                  } else if (activeWaiter !== undefined) {
                    await expectNamedError(handle.requestInput(requests), [
                      "Error",
                    ]);
                  } else if (model.signalAborted) {
                    await expectNamedError(handle.requestInput(requests), [
                      "TaskCancelled",
                    ]);
                  } else if (reused !== undefined) {
                    await expectNamedError(handle.requestInput(requests), [
                      "DuplicateInputKeyError",
                    ]);
                  } else {
                    const tracked = trackWaiter(handle.requestInput(requests));
                    waiters.push(tracked);
                    activeWaiter = tracked;
                    await waitUntilParked(engine);
                    model.status = "input_required";
                    model.inputRequests = new Map(
                      keys.map((key) => [key, ROOTS]),
                    );
                    model.inputResponses = new Map();
                    model.usedInputKeys.push(...keys);
                    commit(model);
                  }
                  break;
                }

                case "respond": {
                  const responses = Object.create(null) as Record<
                    string,
                    unknown
                  >;
                  let applied: string[] = [];
                  if (model.status === "input_required") {
                    const outstanding = [...model.inputRequests!.keys()];
                    const unanswered = outstanding.filter(
                      (key) => !model.inputResponses!.has(key),
                    );
                    if (operation.mode === "all") {
                      applied = unanswered;
                    } else if (operation.mode === "partial") {
                      applied = unanswered.slice(
                        0,
                        Math.max(1, unanswered.length - 1),
                      );
                    } else if (operation.mode === "mixed") {
                      applied = unanswered.slice(0, 1);
                    }
                    for (const key of applied) responses[key] = { roots: [] };
                    let ghost = `ghost-${model.version}`;
                    while (model.inputRequests!.has(ghost)) ghost = `_${ghost}`;
                    if (
                      operation.mode === "none" ||
                      operation.mode === "mixed"
                    ) {
                      responses[ghost] = { roots: [] };
                      const answered = outstanding.find((key) =>
                        model.inputResponses!.has(key),
                      );
                      if (answered !== undefined)
                        responses[answered] = { roots: [] };
                    }
                  }

                  if (!isVisible(model)) {
                    await expectNamedError(
                      engine.updateTask(TASK_ID, responses),
                      ["TaskNotFoundError"],
                    );
                  } else {
                    await expect(
                      engine.updateTask(TASK_ID, responses),
                    ).resolves.toEqual({
                      resultType: "complete",
                    });
                    if (
                      !isTerminal(model.status) &&
                      model.status === "input_required"
                    ) {
                      const newlyApplied = applied.filter(
                        (key) => !model.inputResponses!.has(key),
                      );
                      if (newlyApplied.length > 0) {
                        for (const key of newlyApplied) {
                          model.inputResponses!.set(key, { roots: [] });
                        }
                        commit(model);
                        const complete = [...model.inputRequests!.keys()].every(
                          (key) => model.inputResponses!.has(key),
                        );
                        if (complete) {
                          const expectedResponses = ownRecord(
                            model.inputResponses!,
                          );
                          model.status = "working";
                          model.inputRequests = undefined;
                          model.inputResponses = undefined;
                          if (activeWaiter !== undefined) {
                            await activeWaiter.promise;
                            expect(activeWaiter.outcome).toBe("resolved");
                            expect(activeWaiter.value).toEqual(
                              expectedResponses,
                            );
                            activeWaiter = undefined;
                          }
                        }
                      }
                    }
                  }
                  break;
                }

                case "cancel":
                  if (!isVisible(model)) {
                    await expectNamedError(engine.cancelTask(TASK_ID), [
                      "TaskNotFoundError",
                    ]);
                  } else {
                    await expect(engine.cancelTask(TASK_ID)).resolves.toEqual({
                      resultType: "complete",
                    });
                    if (!isTerminal(model.status)) {
                      model.signalAborted = true;
                      if (activeWaiter !== undefined) {
                        await activeWaiter.promise.catch(() => undefined);
                        expect(activeWaiter.outcome).toBe("rejected");
                        activeWaiter = undefined;
                      }
                    }
                  }
                  break;

                case "finish": {
                  const payload = { value: operation.value };
                  const finish =
                    operation.status === "completed"
                      ? handle.complete(payload)
                      : operation.status === "failed"
                        ? handle.fail(payload)
                        : handle.cancelled(`cancelled ${operation.value}`);

                  if (!isVisible(model)) {
                    await expectNamedError(finish, ["TaskNotFoundError"]);
                  } else if (isTerminal(model.status)) {
                    await expectNamedError(finish, [
                      "TaskAlreadyTerminalError",
                    ]);
                  } else {
                    await finish;
                    model.status = operation.status;
                    model.inputRequests = undefined;
                    model.inputResponses = undefined;
                    if (operation.status === "completed")
                      model.result = payload;
                    if (operation.status === "failed") model.error = payload;
                    if (operation.status === "cancelled") {
                      model.statusMessage = `cancelled ${operation.value}`;
                    }
                    commit(model);
                    if (activeWaiter !== undefined) {
                      await activeWaiter.promise.catch(() => undefined);
                      expect(activeWaiter.outcome).toBe("rejected");
                      activeWaiter = undefined;
                    }
                  }
                  break;
                }
              }

              await assertState(model, engine, store, waiters, activeWaiter);
            }
          } finally {
            await engine.close();
            await flushEffects();
            for (const waiter of waiters) {
              expect(waiter.settlements).toBe(1);
            }
          }
        },
      ),
      { numRuns: 150 },
    );
  }, 30_000);
});
