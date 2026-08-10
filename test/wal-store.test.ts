import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConcurrentUpdateError,
  isTaskEntryTooLargeError,
  TaskEntryTooLargeError,
  TaskLifecycle,
} from "../src/index.js";
import type { TaskRecord } from "../src/index.js";
import { DEFAULT_MAX_ENTRY_BYTES, WalTaskStore } from "../src/wal.js";

// Real file I/O in throwaway directories, no mocking — the filesystem
// behaviour is the thing under test, exactly as in process-wal itself. The
// SIGKILL child-process tests are a separate suite; these cover the store's
// own contract and the reopen path.

const dirs: string[] = [];
const stores: WalTaskStore[] = [];

function freshDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "mdt-wal-"));
  dirs.push(dir);
  return dir;
}

function open(
  dir: string,
  options: { now?: () => number; compactEvery?: number | null } = {},
) {
  const store = new WalTaskStore({ dir, ...options });
  stores.push(store);
  return store;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function record(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: "t1",
    status: "working",
    createdAt: "2026-08-09T12:00:00.000Z",
    lastUpdatedAt: "2026-08-09T12:00:00.000Z",
    ttlMs: null,
    version: 0,
    ...overrides,
  } as TaskRecord;
}

function clock(start = Date.parse("2026-08-09T12:00:00.000Z")) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe("durability across reopen (I8)", () => {
  it("recovers a non-terminal task at its last written state", async () => {
    const dir = freshDir();
    const first = open(dir);
    await first.create(record());
    await first.update("t1", { statusMessage: "halfway" }, 0);
    await first.close();

    const second = open(dir);
    expect(await second.get("t1")).toMatchObject({
      status: "working",
      statusMessage: "halfway",
      version: 1,
    });
  });

  it("keeps a terminal result after reopen", async () => {
    const dir = freshDir();
    const first = open(dir);
    await first.create(record());
    await first.update(
      "t1",
      { status: "completed", result: { answer: 42 } },
      0,
    );
    await first.close();

    const second = open(dir);
    expect(await second.get("t1")).toMatchObject({
      status: "completed",
      result: { answer: 42 },
    });
  });

  it("replays signed zero in its canonical JSON representation", async () => {
    const dir = freshDir();
    const first = open(dir);
    await first.create(
      record({ status: "completed", result: { signedZero: -0 } }),
    );
    const live = (await first.get("t1"))!.result as { signedZero: number };
    expect(Object.is(live.signedZero, 0)).toBe(true);
    await first.close();

    const reopened = open(dir);
    const replayed = (await reopened.get("t1"))!.result as {
      signedZero: number;
    };
    expect(Object.is(replayed.signedZero, 0)).toBe(true);
  });

  // The subtle one. Checkpointing a task the moment it goes terminal would
  // erase it from replay, because replay only returns entries after the
  // checkpoint — and I8 requires the result to survive until the TTL elapses,
  // not until completion.
  it("keeps a terminal result across a compaction and a reopen", async () => {
    const dir = freshDir();
    const first = open(dir);
    await first.create(record());
    await first.update(
      "t1",
      { status: "completed", result: { kept: true } },
      0,
    );
    first.compact();
    await first.close();

    const second = open(dir);
    expect(await second.get("t1")).toMatchObject({
      status: "completed",
      result: { kept: true },
    });
  });

  it("does not resurrect a task that expired while the process was down", async () => {
    const dir = freshDir();
    const time = clock();
    const first = open(dir, { now: time.now });
    await first.create(record({ ttlMs: 1000 }));
    await first.close();

    time.advance(5000);
    const second = open(dir, { now: time.now });
    expect(await second.get("t1")).toBeUndefined();
  });

  it("does not resurrect a swept task", async () => {
    const dir = freshDir();
    const time = clock();
    const first = open(dir, { now: time.now });
    await first.create(record({ ttlMs: 1000 }));
    time.advance(2000);
    expect(await first.sweep()).toBe(1);
    await first.close();

    const second = open(dir, { now: time.now });
    expect(await second.get("t1")).toBeUndefined();
  });

  it("survives many reopens without losing the record", async () => {
    const dir = freshDir();
    for (let round = 0; round < 5; round += 1) {
      const store = open(dir);
      if (round === 0) await store.create(record());
      else {
        const current = (await store.get("t1"))!;
        await store.update(
          "t1",
          { statusMessage: `round ${round}` },
          current.version,
        );
      }
      await store.close();
    }

    const final = open(dir);
    expect(await final.get("t1")).toMatchObject({
      statusMessage: "round 4",
      version: 4,
    });
  });
});

describe("record integrity", () => {
  it("hands out deep copies, so a caller cannot rewrite stored state", async () => {
    const dir = freshDir();
    const store = open(dir);
    const payload = { answer: 1 };
    await store.create(record());
    await store.update("t1", { status: "completed", result: payload }, 0);

    // Mutating the object that was passed in must not reach the store.
    payload.answer = 2;
    expect(await store.get("t1")).toMatchObject({ result: { answer: 1 } });

    // Nor must mutating the object that was handed back.
    const view = (await store.get("t1"))!.result as Record<string, unknown>;
    try {
      view.answer = 3;
    } catch {
      // Frozen records throw here in strict mode; either outcome is fine, the
      // assertion below is what matters.
    }
    expect(await store.get("t1")).toMatchObject({ result: { answer: 1 } });

    await store.close();
    const reopened = open(dir);
    expect(await reopened.get("t1")).toMatchObject({ result: { answer: 1 } });
  });

  it("rejects a non-JSON record before appending anything", async () => {
    const dir = freshDir();
    const first = open(dir);
    const invalid = record({
      status: "completed",
      result: { payload: new Map([["answer", 42]]) } as never,
    });

    await expect(first.create(invalid)).rejects.toBeInstanceOf(TypeError);
    expect(await first.get("t1")).toBeUndefined();
    await first.close();

    const reopened = open(dir);
    expect(await reopened.get("t1")).toBeUndefined();
  });
});

describe("compare-and-swap", () => {
  it("rejects a stale version and leaves the record untouched", async () => {
    const store = open(freshDir());
    await store.create(record());
    await store.update("t1", { statusMessage: "first" }, 0);

    await expect(
      store.update("t1", { statusMessage: "stale" }, 0),
    ).rejects.toBeInstanceOf(ConcurrentUpdateError);
    expect(await store.get("t1")).toMatchObject({ statusMessage: "first" });
  });

  it("reports a missing task as a lost race rather than inventing one", async () => {
    const store = open(freshDir());
    await expect(store.update("ghost", {}, 0)).rejects.toBeInstanceOf(
      ConcurrentUpdateError,
    );
  });

  it("increments the version exactly once per successful write", async () => {
    const store = open(freshDir());
    await store.create(record());
    for (let i = 1; i <= 5; i += 1) {
      const written = await store.update(
        "t1",
        { statusMessage: `${i}` },
        i - 1,
      );
      expect(written.version).toBe(i);
    }
  });
});

describe("patch semantics", () => {
  it("deletes fields whose patch value is undefined, and keeps that across reopen", async () => {
    const dir = freshDir();
    const first = open(dir);
    await first.create(
      record({
        status: "input_required",
        inputRequests: { a: { method: "roots/list" } },
      }),
    );
    await first.update(
      "t1",
      { status: "working", inputRequests: undefined },
      0,
    );
    await first.close();

    const second = open(dir);
    const reopened = (await second.get("t1"))!;
    expect(reopened.status).toBe("working");
    expect("inputRequests" in reopened).toBe(false);
  });
});

describe("compaction", () => {
  it("reclaims superseded history without changing what is readable", async () => {
    const dir = freshDir();
    const store = open(dir, { compactEvery: null });
    await store.create(record());
    for (let i = 1; i <= 50; i += 1) {
      await store.update("t1", { statusMessage: `${i}` }, i - 1);
    }

    const before = readFileSync(path.join(dir, "wal.jsonl"), "utf8").length;
    store.compact();
    const after = readFileSync(path.join(dir, "wal.jsonl"), "utf8").length;

    expect(after).toBeLessThan(before);
    expect(await store.get("t1")).toMatchObject({
      statusMessage: "50",
      version: 50,
    });
  });

  it("runs automatically once superseded entries pile up", async () => {
    const dir = freshDir();
    const store = open(dir, { compactEvery: 10 });
    await store.create(record());
    for (let i = 1; i <= 40; i += 1) {
      await store.update("t1", { statusMessage: `${i}` }, i - 1);
    }

    // Whatever the log holds, it must not have grown linearly with the writes.
    const lines = readFileSync(path.join(dir, "wal.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean);
    expect(lines.length).toBeLessThan(40);
    expect(await store.get("t1")).toMatchObject({ version: 40 });
  });

  it("drops everything when no task is left alive", async () => {
    const dir = freshDir();
    const time = clock();
    const store = open(dir, { now: time.now, compactEvery: null });
    await store.create(record({ ttlMs: 1000 }));
    time.advance(2000);

    store.compact();
    expect(await store.get("t1")).toBeUndefined();

    await store.close();
    const reopened = open(dir, { now: time.now });
    expect(await reopened.get("t1")).toBeUndefined();
  });

  it("reports a usable automatic-compaction failure without rejecting the committed update", async () => {
    const dir = freshDir();
    const initial = record();
    const finalRecord = {
      ...initial,
      statusMessage: "x",
      version: 8,
    };
    const maxEntryBytes = Buffer.byteLength(
      `${JSON.stringify({ seq: 9, value: { t: "put", record: finalRecord } })}\n`,
    );
    const events: Array<{ error: unknown; walUnusable: boolean }> = [];
    const store = new WalTaskStore({
      dir,
      compactEvery: 8,
      maxEntryBytes,
      onCompactionError: (event) => events.push(event),
    });
    stores.push(store);
    await store.create(initial);

    for (let version = 0; version < 8; version += 1) {
      await expect(
        store.update("t1", { statusMessage: "x" }, version),
      ).resolves.toMatchObject({ version: version + 1 });
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      error: { code: "ERR_ENTRY_TOO_LARGE" },
      walUnusable: false,
    });
    await expect(store.get("t1")).resolves.toMatchObject({
      statusMessage: "x",
      version: 8,
    });
  });
});

describe("TTL and sweeping", () => {
  it("hides an expired task from get() before any sweep runs", async () => {
    const time = clock();
    const store = open(freshDir(), { now: time.now });
    await store.create(record({ ttlMs: 1000 }));

    time.advance(999);
    expect(await store.get("t1")).toBeDefined();
    time.advance(1);
    expect(await store.get("t1")).toBeUndefined();
  });

  it("counts what it swept and returns no payloads (I7)", async () => {
    const time = clock();
    const store = open(freshDir(), { now: time.now });
    await store.create(record({ taskId: "a", ttlMs: 1000 }));
    await store.create(record({ taskId: "b", ttlMs: 1000 }));
    await store.create(record({ taskId: "c", ttlMs: null }));

    time.advance(1000);
    const swept = await store.sweep();
    expect(swept).toBe(2);
    expect(await store.get("c")).toBeDefined();
  });
});

describe("the engine on top of it", () => {
  it("carries a full task lifecycle through a restart", async () => {
    const dir = freshDir();
    const store = open(dir);
    const engine = new TaskLifecycle({ store, sweepIntervalMs: null });

    const { taskId } = await engine.createTask({ ttlMs: null });
    await engine.handle(taskId).progress("working on it");
    await engine.handle(taskId).complete({ output: "done" });
    await engine.close();

    const reopened = open(dir);
    const second = new TaskLifecycle({
      store: reopened,
      sweepIntervalMs: null,
    });
    expect(await second.getTask(taskId)).toMatchObject({
      status: "completed",
      result: { output: "done" },
    });
    await second.close();
  });

  it("makes createTask durable before it returns (I1)", async () => {
    const dir = freshDir();
    const store = open(dir);
    const engine = new TaskLifecycle({ store, sweepIntervalMs: null });

    const { taskId } = await engine.createTask({ ttlMs: null });

    // The log on disk already carries it, without anything being closed or
    // flushed by the assertion itself.
    const log = readFileSync(path.join(dir, "wal.jsonl"), "utf8");
    expect(log).toContain(taskId);
    await engine.close();
  });
});

describe("large task results", () => {
  it("uses an 8 MiB task-oriented default", async () => {
    expect(DEFAULT_MAX_ENTRY_BYTES).toBe(8 * 1024 * 1024);
    const dir = freshDir();
    const store = open(dir);
    await store.create(record());
    const result = { blob: "a".repeat(2 * 1024 * 1024) };
    await store.update("t1", { status: "completed", result }, 0);

    await store.close();
    const reopened = open(dir);
    expect((await reopened.get("t1"))?.result).toEqual(result);
  });

  it("throws a typed error and leaves the worker able to complete with a truncated result", async () => {
    const store = new WalTaskStore({
      dir: freshDir(),
      maxEntryBytes: 2 * 1024,
    });
    stores.push(store);
    const engine = new TaskLifecycle({ store, sweepIntervalMs: null });
    const { taskId } = await engine.createTask({ ttlMs: null });
    const handle = engine.handle(taskId);

    let failure: unknown;
    try {
      await handle.complete({ blob: "a".repeat(4 * 1024) });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(TaskEntryTooLargeError);
    expect(isTaskEntryTooLargeError(failure)).toBe(true);
    expect(failure).toMatchObject({
      code: "ERR_ENTRY_TOO_LARGE",
      taskId,
      maxEntryBytes: 2 * 1024,
      cause: { code: "ERR_ENTRY_TOO_LARGE" },
    });
    expect((await engine.getTask(taskId)).status).toBe("working");

    await handle.complete({ truncated: true, summary: "output omitted" });
    expect(await engine.getTask(taskId)).toMatchObject({
      status: "completed",
      result: { truncated: true, summary: "output omitted" },
    });
  });

  it("still enforces the default as a hard bound", async () => {
    const store = open(freshDir());
    await store.create(record());

    await expect(
      store.update(
        "t1",
        {
          status: "completed",
          result: { blob: "a".repeat(DEFAULT_MAX_ENTRY_BYTES + 1) },
        },
        0,
      ),
    ).rejects.toBeInstanceOf(TaskEntryTooLargeError);
    expect(await store.get("t1")).toMatchObject({ status: "working" });
  });
});

describe("closed store", () => {
  it("refuses every method except close", async () => {
    const store = new WalTaskStore({ dir: freshDir() });
    await store.close();

    await expect(store.get("t1")).rejects.toThrow(/closed/i);
    await expect(store.create(record())).rejects.toThrow(/closed/i);
    await expect(store.update("t1", {}, 0)).rejects.toThrow(/closed/i);
    await expect(store.sweep()).rejects.toThrow(/closed/i);
    await expect(store.close()).resolves.toBeUndefined();
  });
});
