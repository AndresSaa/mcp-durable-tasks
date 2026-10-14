import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TaskCancelled,
  TaskNotFoundError,
  type TaskRecord,
} from "../src/index.js";
import { MAX_TIMER_MS } from "../src/validation.js";
import { WorkerCoordinator } from "../src/worker-coordinator.js";

// Process-local bookkeeping must be bounded by the life of the tasks it
// tracks. Sizes are read directly from the coordinator, so these tests do not
// depend on garbage collection or on how long anything takes.

const START = Date.parse("2026-08-09T12:00:00.000Z");

function record(taskId: string, ttlMs: number | null): TaskRecord {
  return {
    taskId,
    status: "working",
    createdAt: new Date(START).toISOString(),
    lastUpdatedAt: new Date(START).toISOString(),
    ttlMs,
    version: 0,
  };
}

let current = START;
const now = () => current;

beforeEach(() => {
  current = START;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a cancellation with no local worker", () => {
  it("is released when the task expires, for every one of 20,000 tasks", () => {
    const workers = new WorkerCoordinator(now);
    for (let index = 0; index < 20_000; index += 1) {
      const taskId = `t${index}`;
      workers.abort(taskId, new TaskCancelled(taskId), record(taskId, 1_000));
    }
    expect(workers.trackedTasks).toBe(20_000);

    current += 1_000;
    vi.advanceTimersByTime(1_000);

    expect(workers.trackedTasks).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stays raised until then, so a worker that reads the signal late still sees it", () => {
    const workers = new WorkerCoordinator(now);
    workers.abort("t", new TaskCancelled("t"), record("t", 1_000));

    current += 999;
    vi.advanceTimersByTime(999);
    expect(workers.signalFor("t").aborted).toBe(true);
    expect(workers.signalFor("t").reason).toBeInstanceOf(TaskCancelled);
  });

  it("is kept while the clock has not reached expiry, even if the timer fires early", () => {
    const workers = new WorkerCoordinator(now);
    workers.abort("t", new TaskCancelled("t"), record("t", 1_000));

    // The timer is due, but the injected clock says the task is still live.
    vi.advanceTimersByTime(1_000);
    expect(workers.trackedTasks).toBe(1);
    expect(workers.signalFor("t").aborted).toBe(true);

    current += 1_000;
    vi.advanceTimersByTime(1_000);
    expect(workers.trackedTasks).toBe(0);
  });

  it("follows a TTL the worker revised through this lifecycle", () => {
    const workers = new WorkerCoordinator(now);
    workers.abort("t", new TaskCancelled("t"), record("t", 1_000));
    workers.observe({ ...record("t", 5_000), version: 1 });

    current += 1_000;
    vi.advanceTimersByTime(1_000);
    expect(workers.trackedTasks).toBe(1);

    current += 4_000;
    vi.advanceTimersByTime(4_000);
    expect(workers.trackedTasks).toBe(0);
  });

  it("is kept for a task with no TTL, which never expires", () => {
    const workers = new WorkerCoordinator(now);
    workers.abort("t", new TaskCancelled("t"), record("t", null));
    expect(vi.getTimerCount()).toBe(0);
    expect(workers.trackedTasks).toBe(1);
  });

  it("is kept, like the store keeps it, when createdAt does not parse", () => {
    // hasExpired() never expires such a record, so releasing it here would
    // drop the signal of a task the store still serves.
    const workers = new WorkerCoordinator(now);
    workers.abort("t", new TaskCancelled("t"), {
      ...record("t", 1_000),
      createdAt: "not a date",
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(workers.trackedTasks).toBe(1);
  });

  it("is released by a terminal transition and by close(), with no timer left", () => {
    const workers = new WorkerCoordinator(now);
    workers.abort("a", new TaskCancelled("a"), record("a", 1_000));
    workers.abort("b", new TaskCancelled("b"), record("b", 1_000));

    workers.observe({ ...record("a", 1_000), status: "cancelled", version: 1 });
    expect(workers.trackedTasks).toBe(1);

    workers.close(new Error("closed"));
    expect(workers.trackedTasks).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("a parked worker", () => {
  it("is rejected and released at expiry, with a single timer for the task", async () => {
    const workers = new WorkerCoordinator(now);
    const registration = workers.register("t", ["a"]);
    workers.observe({
      ...record("t", 1_000),
      status: "input_required",
      inputRequests: {},
    });
    expect(vi.getTimerCount()).toBe(1);

    current += 1_000;
    vi.advanceTimersByTime(1_000);
    await expect(registration.promise).rejects.toMatchObject({
      name: "TaskNotFoundError",
    });
    expect(workers.trackedTasks).toBe(0);
  });
});

// A worker that already holds `handle.signal` learns that its task expired:
// the signal is aborted with the same TaskNotFoundError a later write or
// tasks/get would produce. Cooperative and process-local, like cancellation.
describe("a held signal at expiry", () => {
  function held(
    workers: WorkerCoordinator,
    taskId: string,
    ttlMs: number | null,
  ) {
    const signal = workers.signalFor(taskId);
    workers.observe({ ...record(taskId, ttlMs), version: 1 });
    return signal;
  }

  it("is aborted with TaskNotFoundError and released, with no timer left", () => {
    const workers = new WorkerCoordinator(now);
    const signal = held(workers, "t", 1_000);
    const onAbort = vi.fn();
    signal.addEventListener("abort", onAbort);

    current += 999;
    vi.advanceTimersByTime(999);
    expect(signal.aborted).toBe(false);

    current += 1;
    vi.advanceTimersByTime(1);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBeInstanceOf(TaskNotFoundError);
    expect(signal.reason).toMatchObject({ taskId: "t" });
    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(workers.trackedTasks).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is never aborted for a task with ttlMs null", () => {
    const workers = new WorkerCoordinator(now);
    const signal = held(workers, "t", null);

    const year = 365 * 24 * 3_600_000;
    current += year;
    vi.advanceTimersByTime(year);
    expect(signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(workers.trackedTasks).toBe(1);

    workers.close(new Error("closed"));
    expect(workers.trackedTasks).toBe(0);
  });

  it("follows a TTL extended by a later commit and is not aborted at the old expiry", () => {
    const workers = new WorkerCoordinator(now);
    const signal = held(workers, "t", 1_000);
    workers.observe({ ...record("t", 5_000), version: 2 });

    current += 1_000;
    vi.advanceTimersByTime(1_000);
    expect(signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(1);

    current += 4_000;
    vi.advanceTimersByTime(4_000);
    expect(signal.aborted).toBe(true);
    expect(workers.trackedTasks).toBe(0);
  });

  it("is not aborted while the injected clock disagrees, even if the timer fires", () => {
    const workers = new WorkerCoordinator(now);
    const signal = held(workers, "t", 1_000);

    vi.advanceTimersByTime(1_000);
    expect(signal.aborted).toBe(false);
    expect(workers.trackedTasks).toBe(1);

    current += 1_000;
    vi.advanceTimersByTime(1_000);
    expect(signal.aborted).toBe(true);
  });

  it("ignores a record older than the one already tracked", () => {
    const workers = new WorkerCoordinator(now);
    const signal = held(workers, "t", 1_000);
    workers.observe({ ...record("t", null), version: 3 });
    // A stale record, like the one a cancel read before the last commit.
    workers.abort("t", new TaskCancelled("t"), {
      ...record("t", 1_000),
      version: 2,
    });

    current += 1_000;
    vi.advanceTimersByTime(1_000);
    expect(signal.reason).toBeInstanceOf(TaskCancelled);
    expect(workers.trackedTasks).toBe(1);
  });

  it("keeps the cancellation reason of a signal already raised", () => {
    const workers = new WorkerCoordinator(now);
    const signal = workers.signalFor("t");
    workers.abort("t", new TaskCancelled("t"), record("t", 1_000));

    current += 1_000;
    vi.advanceTimersByTime(1_000);
    expect(signal.reason).toBeInstanceOf(TaskCancelled);
    expect(workers.trackedTasks).toBe(0);
  });

  it("rejects a parked waiter exactly once, with TaskNotFoundError, and aborts the signal", async () => {
    const workers = new WorkerCoordinator(now);
    const registration = workers.register("t", ["a"]);
    const signal = workers.signalFor("t");
    workers.observe({
      ...record("t", 1_000),
      status: "input_required",
      inputRequests: {},
      version: 1,
    });
    const settled = vi.fn();
    registration.promise.then(settled, settled);

    current += 1_000;
    vi.advanceTimersByTime(1_000);
    await expect(registration.promise).rejects.toBeInstanceOf(
      TaskNotFoundError,
    );
    expect(settled).toHaveBeenCalledTimes(1);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe(settled.mock.calls[0]![0]);
    expect(workers.trackedTasks).toBe(0);
  });

  it("stays bounded across 20,000 held signals", () => {
    const workers = new WorkerCoordinator(now);
    const signals = Array.from({ length: 20_000 }, (_, index) =>
      held(workers, `t${index}`, 1_000),
    );
    current += 1_000;
    vi.advanceTimersByTime(1_000);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(workers.trackedTasks).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// A worker may read its signal and never write again, so nothing else would
// tell this process the task's TTL. Reading the signal for the first time
// looks the record up once, with a pure read, to arm the expiry.
describe("a signal read before any commit", () => {
  function lookupOf(records: Map<string, TaskRecord>) {
    return vi.fn(async (taskId: string) => records.get(taskId));
  }

  it("arms its expiry from one lookup and is aborted when the TTL elapses", async () => {
    const lookup = lookupOf(new Map([["t", record("t", 1_000)]]));
    const workers = new WorkerCoordinator(now, lookup);
    const signal = workers.signalFor("t");
    workers.signalFor("t");
    await vi.advanceTimersByTimeAsync(0);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    current += 1_000;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(signal.reason).toBeInstanceOf(TaskNotFoundError);
    expect(workers.trackedTasks).toBe(0);
  });

  it("is aborted at once when the task is already gone", async () => {
    const workers = new WorkerCoordinator(now, lookupOf(new Map()));
    const signal = workers.signalFor("t");
    await vi.advanceTimersByTimeAsync(0);
    expect(signal.reason).toBeInstanceOf(TaskNotFoundError);
    expect(workers.trackedTasks).toBe(0);
  });

  it("is released without aborting when the task is already terminal", async () => {
    const lookup = lookupOf(
      new Map([
        ["t", { ...record("t", 1_000), status: "completed", result: {} }],
      ]),
    );
    const workers = new WorkerCoordinator(now, lookup);
    const signal = workers.signalFor("t");
    await vi.advanceTimersByTimeAsync(0);
    expect(signal.aborted).toBe(false);
    expect(workers.trackedTasks).toBe(0);
  });

  it("does not override a newer commit observed while the lookup was in flight", async () => {
    let answer!: (value: TaskRecord) => void;
    const workers = new WorkerCoordinator(
      now,
      () =>
        new Promise<TaskRecord>((resolve) => {
          answer = resolve;
        }),
    );
    const signal = workers.signalFor("t");
    workers.observe({ ...record("t", null), version: 1 });
    answer(record("t", 1_000));
    await vi.advanceTimersByTimeAsync(0);

    current += 1_000;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("swallows a failed lookup and keeps the signal until close()", async () => {
    const workers = new WorkerCoordinator(now, () =>
      Promise.reject(new Error("store unavailable")),
    );
    const signal = workers.signalFor("t");
    await vi.advanceTimersByTimeAsync(0);
    expect(signal.aborted).toBe(false);
    expect(workers.trackedTasks).toBe(1);
    workers.close(new Error("closed"));
    expect(workers.trackedTasks).toBe(0);
  });

  it("treats a lookup that throws synchronously like a failed one", async () => {
    const workers = new WorkerCoordinator(now, () => {
      throw new Error("store closed");
    });
    const signal = workers.signalFor("t");
    await vi.advanceTimersByTimeAsync(0);
    expect(signal.aborted).toBe(false);
    expect(workers.trackedTasks).toBe(1);
  });

  it("re-checks the store at expiry and follows a TTL revised elsewhere", async () => {
    const records = new Map([["t", record("t", 1_000)]]);
    const lookup = lookupOf(records);
    const workers = new WorkerCoordinator(now, lookup);
    const signal = workers.signalFor("t");
    await vi.advanceTimersByTimeAsync(0);
    // Another instance extends the TTL; this one never sees the commit.
    records.set("t", { ...record("t", 5_000), version: 4 });

    current += 1_000;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(1);

    current += 4_000;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(signal.reason).toBeInstanceOf(TaskNotFoundError);
    expect(workers.trackedTasks).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a timer longer than setTimeout allows split, and re-checks only at the end", async () => {
    const ttlMs = 3 * MAX_TIMER_MS;
    const lookup = lookupOf(new Map([["t", record("t", ttlMs)]]));
    const workers = new WorkerCoordinator(now, lookup);
    const signal = workers.signalFor("t");
    await vi.advanceTimersByTimeAsync(0);

    for (let step = 0; step < 2; step += 1) {
      current += MAX_TIMER_MS;
      await vi.advanceTimersByTimeAsync(MAX_TIMER_MS);
      expect(vi.getTimerCount()).toBe(1);
    }
    expect(lookup).toHaveBeenCalledTimes(1);
    current += MAX_TIMER_MS;
    await vi.advanceTimersByTimeAsync(MAX_TIMER_MS);
    expect(signal.reason).toBeInstanceOf(TaskNotFoundError);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("is released at expiry when the re-check read fails", async () => {
    let fail = false;
    const workers = new WorkerCoordinator(now, async (taskId) => {
      if (fail) throw new Error("store unavailable");
      return record(taskId, 1_000);
    });
    const signal = workers.signalFor("t");
    await vi.advanceTimersByTimeAsync(0);
    fail = true;

    current += 1_000;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(signal.reason).toBeInstanceOf(TaskNotFoundError);
    expect(workers.trackedTasks).toBe(0);
  });

  it("ignores a re-check answer once a newer commit was observed", async () => {
    let calls = 0;
    let answer!: (value: TaskRecord | undefined) => void;
    const workers = new WorkerCoordinator(now, (taskId) => {
      calls += 1;
      if (calls === 1) return Promise.resolve(record(taskId, 1_000));
      return new Promise((resolve) => (answer = resolve));
    });
    const signal = workers.signalFor("t");
    await vi.advanceTimersByTimeAsync(0);

    current += 1_000;
    await vi.advanceTimersByTimeAsync(1_000);
    workers.observe({ ...record("t", null), version: 2 });
    answer(undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(signal.aborted).toBe(false);
    expect(workers.trackedTasks).toBe(1);
  });

  it("stays bounded across 20,000 re-checked expiries", async () => {
    const workers = new WorkerCoordinator(now, async () => undefined);
    const signals = Array.from({ length: 20_000 }, (_, index) => {
      const taskId = `t${index}`;
      const signal = workers.signalFor(taskId);
      workers.observe({ ...record(taskId, 1_000), version: 1 });
      return signal;
    });
    current += 1_000;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(workers.trackedTasks).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does nothing once closed", async () => {
    let answer!: (value: TaskRecord | undefined) => void;
    const workers = new WorkerCoordinator(
      now,
      () =>
        new Promise<TaskRecord | undefined>((resolve) => {
          answer = resolve;
        }),
    );
    const signal = workers.signalFor("t");
    workers.close(new Error("closed"));
    answer(undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(signal.aborted).toBe(false);
    expect(workers.trackedTasks).toBe(0);
  });
});
