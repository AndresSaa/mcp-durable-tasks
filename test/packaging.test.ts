import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

// The manifest is not just metadata here. The public contract explains that the npm
// "mcp task*" namespace is entirely to-do-list managers, and that the only
// things separating this package from them are its description, its keywords
// and the word "durable". That makes those fields load-bearing, and a tidy-up
// that "simplifies" the description is a regression in the one dimension this
// project cannot afford to lose. Hence a test rather than a convention.

const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as {
  name: string;
  description: string;
  keywords: string[];
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  exports: Record<string, unknown>;
  files: string[];
  engines: { node: string };
};

describe("positioning", () => {
  it("is named mcp-durable-tasks", () => {
    expect(manifest.name).toBe("mcp-durable-tasks");
  });

  // The public contract reserves that name for a possible future official package from
  // the spec's own maintainers. Taking it burns the relationship the whole
  // project exists to build.
  it("never squats the official package's name", () => {
    expect(manifest.name).not.toBe("mcp-ext-tasks");
    expect(JSON.stringify(manifest)).not.toContain("mcp-ext-tasks");
  });

  it("keeps the disambiguating sentence in the description", () => {
    expect(manifest.description).toContain("Not a to-do manager");
  });

  it("names the extension it implements in the description", () => {
    expect(manifest.description).toContain("SEP-2663");
  });

  // "durable" is the spec's own vocabulary and the word that separates this
  // from the to-do managers. It is required in the keywords for the same
  // reason it is required in the name.
  it("carries the keywords that make it findable as what it is", () => {
    for (const keyword of [
      "mcp",
      "model-context-protocol",
      "sep-2663",
      "io.modelcontextprotocol/tasks",
      "durable",
      "task-store",
    ]) {
      expect(manifest.keywords).toContain(keyword);
    }
  });
});

describe("dependency boundary", () => {
  it("declares no runtime dependencies at all", () => {
    expect(manifest.dependencies).toBeUndefined();
  });

  // The public contract: whoever wants only MemoryTaskStore must not be made to
  // install process-wal. A plain peer dependency would warn on install; an
  // optional one is silent unless the /wal entry point is actually used.
  it("keeps process-wal an optional peer", () => {
    expect(manifest.peerDependencies?.["process-wal"]).toBeDefined();
    expect(manifest.peerDependenciesMeta?.["process-wal"]?.optional).toBe(true);
  });
});

describe("entry points", () => {
  it("exposes exactly the three public entry points", () => {
    expect(Object.keys(manifest.exports).sort()).toEqual([
      ".",
      "./testing",
      "./wal",
    ]);
  });

  it("requires Node 22 or newer", () => {
    expect(manifest.engines.node).toBe(">=22");
  });

  it("recognises a WAL error created by the separate CJS entry bundle", async () => {
    const require = createRequire(import.meta.url);
    const main = require("../dist/index.cjs") as {
      isTaskEntryTooLargeError(error: unknown): boolean;
    };
    const wal = require("../dist/wal.cjs") as {
      WalTaskStore: new (options: { dir: string; maxEntryBytes: number }) => {
        create(record: object): Promise<void>;
        close(): Promise<void>;
      };
    };
    const dir = mkdtempSync(path.join(tmpdir(), "mdt-cjs-errors-"));
    const store = new wal.WalTaskStore({ dir, maxEntryBytes: 256 });
    try {
      let failure: unknown;
      try {
        await store.create({
          taskId: "large",
          status: "completed",
          createdAt: "2026-08-10T00:00:00.000Z",
          lastUpdatedAt: "2026-08-10T00:00:00.000Z",
          ttlMs: null,
          version: 0,
          result: { blob: "x".repeat(1_024) },
        });
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeDefined();
      expect(main.isTaskEntryTooLargeError(failure)).toBe(true);
    } finally {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("published documentation", () => {
  it("ships the public contract and omits private planning documents", () => {
    expect(
      manifest.files.filter((file) => file.startsWith("docs/")).sort(),
    ).toEqual([
      "docs/api.md",
      "docs/contract.md",
      "docs/durability.md",
      "docs/internals.md",
    ]);
  });
});
