import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// publint and attw read the package; they never load it. A broken exports map,
// a file left out of `files`, or a build that emits something Node refuses to
// parse all pass static analysis and fail on the consumer's first import.
//
// So this installs the tarball CI would publish into a throwaway package and
// imports it *by name*, which is what resolves through `exports` — importing
// dist/ by path would prove much less.
//
// The workspace deliberately never installs `process-wal`. That is the check
// this package needs beyond process-wal's own: the main and testing entry
// points must resolve and load with the optional peer absent, or the promise
// that MemoryTaskStore costs no dependencies is not true. The `wal` entry
// point is left out of the checks for exactly the same reason — it is the one
// that may need the peer, so loading it here would prove the opposite of what
// this asserts. Its own smoke check arrives with WalTaskStore.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspace = mkdtempSync(path.join(tmpdir(), "mdt-smoke-"));

// pnpm is a .cmd shim on Windows, which Node refuses to spawn directly. Going
// through cmd.exe rather than `shell: true` keeps the arguments a real argv:
// concatenating them into a shell string is what DEP0190 warns about.
const windows = process.platform === "win32";
const pnpm = (args, cwd) => {
  const options = {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  };

  try {
    return execFileSync(
      windows ? "cmd.exe" : "pnpm",
      windows ? ["/c", "pnpm", ...args] : args,
      options,
    ).trim();
  } catch (directError) {
    try {
      return execFileSync(
        windows ? "cmd.exe" : "corepack",
        windows ? ["/c", "corepack", "pnpm", ...args] : ["pnpm", ...args],
        options,
      ).trim();
    } catch (corepackError) {
      corepackError.cause = directError;
      throw corepackError;
    }
  }
};

try {
  const tarball = path.join(workspace, "mcp-durable-tasks-smoke.tgz");
  pnpm(["pack", "--out", tarball], root);

  writeFileSync(
    path.join(workspace, "package.json"),
    JSON.stringify({ name: "mdt-smoke", version: "0.0.0", private: true }),
  );
  pnpm(["add", "--silent", "--ignore-scripts", tarball], workspace);

  // Exercising the real surface, not a placeholder: an entry point that
  // resolves but whose exports are missing would pass a bare import check.
  // Creating a task through MemoryTaskStore also proves the engine runs with
  // no dependencies present.
  const smoke = (kind) => `
    const { TaskLifecycle, MemoryTaskStore, TaskNotFoundError } = ${kind};
    const engine = new TaskLifecycle({ store: new MemoryTaskStore(), sweepIntervalMs: null });
    const created = await engine.createTask();
    if (typeof created.taskId !== "string") throw new Error("no taskId");
    if (created.status !== "working") throw new Error("wrong status");
    const view = await engine.getTask(created.taskId);
    if (view.status !== "working") throw new Error("get returned the wrong task");
    if ("version" in view) throw new Error("internal field leaked to the wire");
    await engine.handle(created.taskId).complete({ ok: true });
    if (typeof TaskNotFoundError !== "function") throw new Error("errors missing");
    await engine.close();
  `;

  // The conformance kit is a product, not an internal helper, so the packed
  // tarball has to be able to run it — against MemoryTaskStore, in a workspace
  // with no process-wal, which is exactly the situation a third party writing
  // their own store starts from.
  const testingSmoke = (testingKind, mainKind) => `
    const { checkTaskStore, conformanceChecks } = ${testingKind};
    const { MemoryTaskStore } = ${mainKind};
    // A fresh clock per call: the factory runs once per check, and sharing one
    // would leak advanced time between them.
    const report = await checkTaskStore("smoke", () => {
      let now = Date.parse("2026-01-01T00:00:00.000Z");
      return {
        store: new MemoryTaskStore({ now: () => now }),
        advanceTime: (ms) => { now += ms; },
      };
    });
    if (!report.ok) throw new Error("conformance kit failed on MemoryTaskStore: " + report.outcomes.filter((o) => o.status === "failed").map((o) => o.name + " -> " + (o.error && o.error.message || o.error)).join("; "));
    const expectedSkipped = conformanceChecks.filter((check) => check.needsReopen === true).length;
    if (report.skipped !== expectedSkipped) throw new Error("conformance kit reported the wrong reopen skips");
    if (report.passed !== conformanceChecks.length - expectedSkipped) throw new Error("conformance kit did not run every supported check");
    if (report.outcomes.some((outcome) => outcome.status === "skipped" && !outcome.reason.includes("reopen"))) throw new Error("conformance kit skipped an unexpected capability");
  `;

  const checks = [
    ["ESM · main", "module", smoke('await import("mcp-durable-tasks")')],
    ["CJS · main", "commonjs", smoke('require("mcp-durable-tasks")')],
    [
      "ESM · testing",
      "module",
      testingSmoke(
        'await import("mcp-durable-tasks/testing")',
        'await import("mcp-durable-tasks")',
      ),
    ],
    [
      "CJS · testing",
      "commonjs",
      testingSmoke(
        'require("mcp-durable-tasks/testing")',
        'require("mcp-durable-tasks")',
      ),
    ],
  ];

  for (const [label, type, source] of checks) {
    execFileSync(
      process.execPath,
      ["--input-type", type, "-e", `(async () => {${source}})()`],
      {
        cwd: workspace,
        stdio: ["ignore", "inherit", "inherit"],
      },
    );
    console.log(
      `${label}: resolved by name from the packed tarball, without process-wal installed`,
    );
  }
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
