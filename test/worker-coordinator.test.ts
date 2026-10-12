import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskCancelled, type TaskRecord } from "../src/index.js";
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
    const registration = workers.register("t");
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
