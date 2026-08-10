import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { TaskLifecycle } from "../src/index.js";
import { WalTaskStore } from "../src/wal.js";

// The six durability scenarios in docs/contract.md, each with a real child process and
// a real SIGKILL. Nothing here simulates a crash with a flag, and nothing
// sleeps: the child announces over IPC that it has reached the state under
// test, and the kill happens on that message. That is what makes these
// deterministic rather than timing-dependent.
//
// The child runs against dist/, so what is proven to recover is the artifact a
// consumer installs.

const CHILD = fileURLToPath(new URL("./crash/child.mjs", import.meta.url));

const dirs: string[] = [];
const children: ChildProcess[] = [];

function freshDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "mdt-crash-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/**
 * Runs a scenario to its announced state and then kills it outright.
 *
 * `SIGKILL` is not catchable and not deferrable, on Windows too — Node maps it
 * onto `TerminateProcess`, which is the closest thing the platform has to
 * pulling the plug on a process while leaving its written pages alone. That
 * distinction is the whole point: what survives here is what the kernel
 * already had, not what a shutdown hook managed to flush.
 */
async function killDuring(
  scenario: string,
  dir: string,
): Promise<{
  taskId: string;
  committedVersion?: number;
  committedStatusMessage?: string;
  fillerTaskIds?: string[];
}> {
  const child = fork(CHILD, [dir, scenario], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.push(child);

  const announced = await new Promise<{
    taskId: string;
    committedVersion?: number;
    committedStatusMessage?: string;
    fillerTaskIds?: string[];
  }>((resolve, reject) => {
    child.once("message", (message) =>
      resolve(
        message as {
          taskId: string;
          committedVersion?: number;
          committedStatusMessage?: string;
          fillerTaskIds?: string[];
        },
      ),
    );
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      reject(
        new Error(`child exited before announcing (code ${code}, ${signal})`),
      ),
    );
  });

  const exited = new Promise<NodeJS.Signals | null>((resolve) => {
    child.once("exit", (_code, signal) => resolve(signal));
  });

  child.kill("SIGKILL");
  await exited;

  return announced;
}

/** Reopens the directory the way a restarted server would. */
async function reopen<T>(
  dir: string,
  body: (engine: TaskLifecycle, store: WalTaskStore) => Promise<T>,
  options: { now?: () => number } = {},
): Promise<T> {
  const store = new WalTaskStore({ dir, compactEvery: null, ...options });
  const engine = new TaskLifecycle({ store, sweepIntervalMs: null });
  try {
    return await body(engine, store);
  } finally {
    await engine.close();
  }
}

describe("crash recovery (I8)", () => {
  it("recovers a task created but never touched again", async () => {
    const dir = freshDir();
    const { taskId } = await killDuring("created", dir);

    // The server already handed this id to a client. Losing it here is the
    // failure the whole package exists to prevent.
    await reopen(dir, async (engine) => {
      const view = await engine.getTask(taskId);
      expect(view.status).toBe("working");
      expect(view.taskId).toBe(taskId);
    });
  });

  it("recovers a parked task with its input requests intact", async () => {
    const dir = freshDir();
    const { taskId } = await killDuring("input-required", dir);

    await reopen(dir, async (engine) => {
      const view = await engine.getTask(taskId);
      expect(view.status).toBe("input_required");
      const parked = view as { inputRequests: Record<string, unknown> };
      expect(Object.keys(parked.inputRequests).sort()).toEqual([
        "round-1-elicit",
        "round-1-roots",
      ]);
    });
  });

  it("keeps the used-key ledger across the crash, so keys are never reused (I5)", async () => {
    const dir = freshDir();
    const { taskId } = await killDuring("input-required", dir);

    // The ledger is internal, so this asserts the consequence rather than the
    // field: the restarted process must still refuse a key the dead one issued.
    await reopen(dir, async (engine, store) => {
      const record = await store.get(taskId);
      expect(record?.usedInputKeys).toEqual(
        expect.arrayContaining(["round-1-roots", "round-1-elicit"]),
      );

      await engine.updateTask(taskId, {
        "round-1-roots": { roots: [] },
        "round-1-elicit": { action: "accept", content: {} },
      });
      const resumed = await engine.getTask(taskId);
      expect(resumed.status).toBe("working");

      await expect(
        engine.handle(taskId).requestInput({
          "round-1-roots": { method: "roots/list" },
        }),
      ).rejects.toMatchObject({ name: "DuplicateInputKeyError" });
    });
  });

  it("keeps a completed result when the process dies the instant it finished", async () => {
    const dir = freshDir();
    const { taskId } = await killDuring("completed", dir);

    await reopen(dir, async (engine) => {
      const view = await engine.getTask(taskId);
      expect(view).toMatchObject({
        status: "completed",
        result: {
          marker: "kept-across-the-crash",
          content: [{ type: "text", text: "the work finished" }],
        },
      });
    });
  });

  it("reopens consistently after a kill in the middle of appends", async () => {
    const dir = freshDir();
    const { taskId, committedVersion, committedStatusMessage } =
      await killDuring("mid-append", dir);
    expect(committedVersion).toBeTypeOf("number");
    expect(committedStatusMessage).toBe("committed before the crash");

    // How far the writer got is genuinely unknowable — that is the nature of
    // the test. What must hold is that the log opens, the acknowledged baseline
    // remains, and any later state is a complete, valid record.
    await reopen(dir, async (engine, store) => {
      const view = await engine.getTask(taskId);
      expect(view.status).toBe("working");

      const record = await store.get(taskId);
      expect(record).toBeDefined();
      expect(typeof record!.version).toBe("number");
      expect(record!.version).toBeGreaterThanOrEqual(committedVersion!);
      if (record!.version === committedVersion) {
        expect(record!.statusMessage).toBe(committedStatusMessage);
      } else {
        expect(record!.statusMessage).toMatch(/^round \d+ /);
      }
      // Every field of a recovered record is well formed, or the tail was
      // welded rather than healed.
      expect(Date.parse(record!.lastUpdatedAt)).not.toBeNaN();
      expect(Date.parse(record!.createdAt)).not.toBeNaN();
      expect(Date.parse(record!.lastUpdatedAt)).toBeGreaterThanOrEqual(
        Date.parse(record!.createdAt),
      );
    });
  });

  it("recovers every committed task after a kill in a compaction loop", async () => {
    const dir = freshDir();
    const { taskId, committedVersion, fillerTaskIds } = await killDuring(
      "mid-compaction",
      dir,
    );
    expect(committedVersion).toBeTypeOf("number");
    expect(fillerTaskIds).toHaveLength(8);

    await reopen(dir, async (_engine, store) => {
      const primary = await store.get(taskId);
      expect(primary).toMatchObject({
        status: "working",
        statusMessage: "primary committed before compaction",
      });
      expect(primary!.version).toBeGreaterThanOrEqual(committedVersion!);

      for (const fillerTaskId of fillerTaskIds!) {
        expect(await store.get(fillerTaskId)).toMatchObject({
          status: "completed",
          result: { marker: fillerTaskId },
        });
      }
    });
  });

  it("survives a torn tail written by the crash, and keeps writing after it", async () => {
    const dir = freshDir();
    const { taskId } = await killDuring("mid-append", dir);

    // Whether that particular kill happened to tear a line is up to the
    // scheduler, so the healing path is also exercised deterministically: a
    // record with no trailing newline is exactly what an interrupted write
    // leaves, and it must be truncated away before the next append rather
    // than fusing with it.
    const log = path.join(dir, "wal.jsonl");
    writeFileSync(log, readFileSync(log, "utf8") + '{"t":"put","record":{"tas');

    await reopen(dir, async (engine, store) => {
      const before = await engine.getTask(taskId);
      expect(before.status).toBe("working");

      const current = (await store.get(taskId))!;
      await store.update(
        taskId,
        { statusMessage: "after the tear" },
        current.version,
      );
      expect(await store.get(taskId)).toMatchObject({
        statusMessage: "after the tear",
      });
    });

    await reopen(dir, async (_engine, store) => {
      expect(await store.get(taskId)).toMatchObject({
        statusMessage: "after the tear",
      });
    });
  });

  it("treats a task whose TTL elapsed while the process was dead as gone", async () => {
    const dir = freshDir();
    const { taskId } = await killDuring("expiring", dir);

    // The crash is real; the passage of time is injected. Waiting out a real
    // TTL would make the test either slow or flaky, and the clock is not what
    // is under test here — the replay path is. The restarted process must not
    // resurrect a task whose window closed while nothing was running.
    const wellPastExpiry = () => Date.now() + 60_000;

    await reopen(
      dir,
      async (engine, store) => {
        await expect(engine.getTask(taskId)).rejects.toMatchObject({
          name: "TaskNotFoundError",
        });
        expect(await store.get(taskId)).toBeUndefined();
        // And it stays gone: nothing counts it as live afterwards either.
        expect(await store.sweep()).toBe(0);
      },
      { now: wellPastExpiry },
    );
  });
});
