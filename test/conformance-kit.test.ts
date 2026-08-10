import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryTaskStore } from "../src/index.js";
import type { TaskPatch, TaskRecord, TaskStore } from "../src/index.js";
import {
  checkTaskStore,
  conformanceChecks,
  runTaskStoreConformance,
  type ConformanceCheck,
} from "../src/testing.js";
import { WalTaskStore } from "../src/wal.js";

// The public contract requires the kit to pass against both included stores.
// It is the product, not an internal helper — so it is exercised here the same
// way a third party would use it, through the public entry point.

function movableClock(start = Date.parse("2026-01-01T00:00:00.000Z")) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

const vitestRunner = {
  describe,
  it,
  skip: (context: unknown, reason: string) => {
    (context as { skip: (reason?: string) => void }).skip(reason);
  },
};

describe("the kit passes against MemoryTaskStore", () => {
  runTaskStoreConformance(
    "MemoryTaskStore",
    () => {
      const clock = movableClock();
      return {
        store: new MemoryTaskStore({ now: clock.now }),
        advanceTime: clock.advance,
      };
    },
    { runner: vitestRunner },
  );
});

describe("the kit passes against WalTaskStore", () => {
  runTaskStoreConformance(
    "WalTaskStore",
    () => {
      const clock = movableClock();
      const dir = mkdtempSync(path.join(tmpdir(), "mdt-conf-"));
      return {
        store: new WalTaskStore({ dir, now: clock.now }),
        advanceTime: clock.advance,
        reopen: () => new WalTaskStore({ dir, now: clock.now }),
        dispose: () => rmSync(dir, { recursive: true, force: true }),
      };
    },
    { runner: vitestRunner },
  );
});

describe("checkTaskStore, the runner-free path", () => {
  it("reports a clean run against a compliant store", async () => {
    const report = await checkTaskStore("MemoryTaskStore", () => {
      const clock = movableClock();
      return {
        store: new MemoryTaskStore({ now: clock.now }),
        advanceTime: clock.advance,
      };
    });

    expect(report.ok).toBe(true);
    expect(report.failed).toBe(0);
    const reopenChecks = conformanceChecks.filter(
      (check) => check.needsReopen === true,
    ).length;
    expect(report.skipped).toBe(reopenChecks);
    expect(report.passed).toBe(conformanceChecks.length - reopenChecks);
  });

  it("skips the time-dependent checks when the factory has no clock seam", async () => {
    const report = await checkTaskStore(
      "MemoryTaskStore (no clock)",
      () => new MemoryTaskStore(),
    );

    // Skipping is not passing: a store with no seam gets an honest report
    // rather than credit for checks that never ran.
    expect(report.ok).toBe(true);
    expect(report.failed).toBe(0);
    expect(report.skipped).toBe(
      conformanceChecks.filter(
        (check) => check.needsClock === true || check.needsReopen === true,
      ).length,
    );
    for (const outcome of report.outcomes) {
      if (outcome.status === "skipped") {
        expect(outcome.reason).toMatch(/advanceTime|reopen/);
      }
    }
  });

  it("enforces a fresh store instance for every check", async () => {
    const shared = new MemoryTaskStore();
    const report = await checkTaskStore(
      "shared store",
      () => shared,
      conformanceChecks.slice(0, 2),
    );

    expect(report.ok).toBe(false);
    expect(report.outcomes[1]?.error).toHaveProperty(
      "message",
      expect.stringMatching(/fresh|reused/i),
    );
  });

  it("reports close failures instead of swallowing them", async () => {
    const check: ConformanceCheck = {
      name: "body succeeds",
      async run() {},
    };
    const report = await checkTaskStore(
      "bad close",
      () => {
        const inner = new MemoryTaskStore();
        return {
          store: {
            create: (record) => inner.create(record),
            get: (taskId) => inner.get(taskId),
            update: (taskId, patch, version) =>
              inner.update(taskId, patch, version),
            sweep: (now) => inner.sweep(now),
            close: async () => {
              throw new Error("close failed");
            },
          },
        };
      },
      [check],
    );

    expect(report.ok).toBe(false);
    expect(report.outcomes[0]?.error).toHaveProperty(
      "message",
      expect.stringMatching(/close failed/i),
    );
  });

  it("fails a hanging operation at the configured deadline", async () => {
    const check: ConformanceCheck = {
      name: "hangs",
      async run({ store }) {
        await store.get("never");
      },
    };
    const report = await checkTaskStore(
      "hanging store",
      () => ({
        store: {
          async create() {},
          get: () => new Promise<TaskRecord | undefined>(() => {}),
          async update() {
            throw new Error("unused");
          },
          async sweep() {
            return 0;
          },
          async close() {},
        },
      }),
      [check],
      { timeoutMs: 25 },
    );

    expect(report.ok).toBe(false);
    expect(report.outcomes[0]?.error).toHaveProperty(
      "message",
      expect.stringMatching(/timed out after 25ms/i),
    );
  });

  it("uses reopen() to detect stores that lose persisted state", async () => {
    const checks = conformanceChecks.filter(
      (check) => check.needsReopen === true,
    );
    const report = await checkTaskStore(
      "forgetful reopen",
      () => ({
        store: new MemoryTaskStore(),
        reopen: () => new MemoryTaskStore(),
      }),
      checks,
    );

    expect(report.ok).toBe(false);
    expect(report.failed).toBe(checks.length);
  });
});

describe("runner skip integration", () => {
  function captureRunner(reasons?: string[]) {
    const bodies: ((context: unknown) => Promise<void> | void)[] = [];
    return {
      bodies,
      runner: {
        describe: (_name: string, body: () => void) => body(),
        it: (
          _name: string,
          body: (context: unknown) => Promise<void> | void,
        ) => {
          bodies.push(body);
        },
        ...(reasons === undefined
          ? {}
          : {
              skip: (_context: unknown, reason: string) => {
                reasons.push(reason);
              },
            }),
      },
    };
  }

  const reopenCheck = conformanceChecks.find(
    (check) => check.needsReopen === true,
  )!;

  it("fails clearly when an optional capability is missing and no skip adapter exists", async () => {
    const captured = captureRunner();
    runTaskStoreConformance("no reopen", () => new MemoryTaskStore(), {
      checks: [reopenCheck],
      runner: captured.runner,
    });

    await expect(captured.bodies[0]!({})).rejects.toThrow(/runner\.skip/);
  });

  it("delegates a real skip to the runner adapter", async () => {
    const reasons: string[] = [];
    const captured = captureRunner(reasons);
    runTaskStoreConformance("no reopen", () => new MemoryTaskStore(), {
      checks: [reopenCheck],
      runner: captured.runner,
    });

    await captured.bodies[0]!({});
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/reopen/);
  });
});

/**
 * A store that is wrong in exactly one way, to prove the kit would notice.
 *
 * A conformance suite nobody has watched fail is a suite that might assert
 * nothing. Each of these is a mistake a real implementation makes: the patch
 * rule is the one everybody gets wrong first, and the other two are the shape
 * of a store built by copying an ordinary CRUD repository.
 */
function brokenStore(
  flaw:
    | "patch-ignores-undefined"
    | "no-cas"
    | "live-references"
    | "drops-used-input-keys",
): TaskStore {
  const tasks = new Map<string, TaskRecord>();
  return {
    async create(record) {
      if (tasks.has(record.taskId)) throw new Error("exists");
      tasks.set(record.taskId, { ...record });
    },
    async get(taskId) {
      const found = tasks.get(taskId);
      if (found === undefined) return undefined;
      if (found.ttlMs !== null) {
        const expiresAt = Date.parse(found.createdAt) + found.ttlMs;
        if (Date.now() >= expiresAt) return undefined;
      }
      // The flawed store hands back its own object.
      return flaw === "live-references" ? found : structuredClone(found);
    },
    async update(taskId, patch: TaskPatch, expectedVersion) {
      const current = tasks.get(taskId);
      if (current === undefined) {
        const error = new Error("missing");
        error.name = "ConcurrentUpdateError";
        throw error;
      }
      if (flaw !== "no-cas" && current.version !== expectedVersion) {
        const error = new Error("stale");
        error.name = "ConcurrentUpdateError";
        throw error;
      }
      const next: Record<string, unknown> = { ...current };
      for (const [key, value] of Object.entries(patch)) {
        if (key === "usedInputKeys" && flaw === "drops-used-input-keys") {
          continue;
        }
        // The classic mistake: undefined read as "leave unchanged".
        if (value === undefined && flaw === "patch-ignores-undefined") continue;
        if (value === undefined) delete next[key];
        else next[key] = value;
      }
      next.version = current.version + 1;
      const written = next as unknown as TaskRecord;
      tasks.set(taskId, written);
      return written;
    },
    async sweep() {
      return 0;
    },
    async close() {},
  };
}

describe("the kit catches stores that are wrong", () => {
  it.each([
    ["patch-ignores-undefined", /undefined/i],
    ["no-cas", /stale version/i],
    ["live-references", /copies|returned object|caller/i],
    ["drops-used-input-keys", /input requests|partial responses|used keys/i],
  ] as const)("fails a store whose flaw is %s", async (flaw, expected) => {
    const report = await checkTaskStore(`broken:${flaw}`, () =>
      brokenStore(flaw),
    );

    expect(report.ok).toBe(false);
    expect(report.failed).toBeGreaterThan(0);
    const failedNames = report.outcomes
      .filter((o) => o.status === "failed")
      .map((o) => o.name)
      .join(" | ");
    expect(failedNames).toMatch(expected);
  });
});
