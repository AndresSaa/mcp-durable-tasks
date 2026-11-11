import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConcurrentUpdateError,
  MemoryTaskStore,
  TaskLifecycle,
  type DetailedTask,
  type TaskStore,
} from "../src/index.js";
import { WalTaskStore } from "../src/wal.js";
import * as wire from "../src/wire.js";

const START = Date.parse("2026-11-10T00:00:00.000Z");
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  vi.restoreAllMocks();
});

const schema = JSON.parse(
  readFileSync(
    new URL("./fixtures/ext-tasks/schema.json", import.meta.url),
    "utf8",
  ),
);
const ajv = new Ajv2020({
  strict: true,
  allowUnionTypes: true,
  formats: { uri: true, byte: true },
});
ajv.addSchema(schema);
const validate = ajv.getSchema(`${schema.$id}#/$defs/TaskStatusNotification`)!;
function conforms(task: DetailedTask) {
  expect(
    validate({ jsonrpc: "2.0", method: "notifications/tasks", params: task }),
    JSON.stringify(validate.errors),
  ).toBe(true);
  for (const field of [
    "version",
    "inputResponses",
    "unclaimedInputResponses",
    "usedInputKeys",
    "foreign",
  ]) {
    expect(task).not.toHaveProperty(field);
  }
}

for (const kind of ["memory", "wal"] as const) {
  describe(`committed changes (${kind})`, () => {
    function setup() {
      let time = START;
      const now = () => time;
      const dir =
        kind === "wal"
          ? mkdtempSync(join(tmpdir(), "mdt-changes-"))
          : undefined;
      const store: TaskStore =
        dir === undefined
          ? new MemoryTaskStore({ now })
          : new WalTaskStore({ dir, now, compactEvery: null });
      const engine = new TaskLifecycle({
        store,
        now,
        generateTaskId: () => "t",
      });
      cleanup.push(async () => {
        await engine.close();
        if (dir) rmSync(dir, { recursive: true, force: true });
      });
      return {
        engine,
        store,
        setTime: (value: number) => {
          time = value;
        },
      };
    }

    it("registers without reads, emits creation after durability, and isolates IDs", async () => {
      const { engine, store } = setup();
      const reached = barrier();
      const resume = barrier();
      const create = store.create.bind(store);
      store.create = async (record) => {
        reached.release();
        await resume.promise;
        await create(record);
      };
      const get = vi.spyOn(store, "get");
      const seen: DetailedTask[] = [];
      engine.onTaskChanged("t", (task) => {
        seen.push(task);
      });
      engine.onTaskChanged(
        "other",
        () => {
          throw new Error("wrong ID");
        },
        {
          onError: (error) => {
            throw error;
          },
        },
      );
      expect(get).not.toHaveBeenCalled();
      const creating = engine.createTask({ ttlMs: null });
      await reached.promise;
      expect(seen).toEqual([]);
      resume.release();
      await creating;
      expect(seen).toEqual([await engine.getTask("t")]);
      conforms(seen[0]!);
    });

    it("emits the canonical polling hint stored at creation", async () => {
      const { engine } = setup();
      const seen: DetailedTask[] = [];
      engine.onTaskChanged("t", (task) => {
        seen.push(task);
      });
      const created = await engine.createTask({
        ttlMs: null,
        pollIntervalMs: -0,
      });
      expect(seen[0]).toEqual(await engine.getTask("t"));
      expect(Object.is(created.pollIntervalMs, -0)).toBe(false);
    });

    it("emits partial and complete input rounds, retained claims and terminal payloads", async () => {
      const { engine, store } = setup();
      const seen: DetailedTask[] = [];
      engine.onTaskChanged("t", (task) => {
        seen.push(task);
        conforms(task);
      });
      await engine.createTask({ ttlMs: null });
      await engine.handle("t").progress("working", { pollIntervalMs: 23 });
      // Another lifecycle represents the worker that parked before a restart.
      const former = new TaskLifecycle({ store, now: () => START });
      const parked = barrier();
      const stop = former.onTaskChanged("t", () => parked.release());
      const waiting = former.handle("t").requestInput({
        a: { method: "roots/list" },
        b: { method: "roots/list" },
      });
      const rejected = waiting.catch(() => undefined);
      await parked.promise;
      stop();
      expect(seen).toHaveLength(2); // foreign commit is not observed here
      await former.cancelTask("t");
      await rejected;
      await engine.updateTask("t", { a: { roots: [] } });
      expect(seen.at(-1)?.status).toBe("input_required");
      const beforeNoop = seen.length;
      await engine.updateTask("t", {
        a: { roots: [] },
        unknown: { roots: [] },
      });
      expect(seen).toHaveLength(beforeNoop);
      await engine.updateTask("t", { b: { roots: [] } });
      expect(seen.at(-1)?.status).toBe("working");
      expect(await engine.handle("t").resumeInput()).toEqual({
        a: { roots: [] },
        b: { roots: [] },
      });
      expect(seen.at(-1)?.status).toBe("working");
      const beforeRead = seen.length;
      await engine.handle("t").resumeInput();
      await engine.getTask("t");
      await engine.cancelTask("t");
      expect(seen).toHaveLength(beforeRead);
      await engine.handle("t").complete({ content: [], nested: { value: 1 } });
      expect(seen.at(-1)).toMatchObject({
        status: "completed",
        result: { nested: { value: 1 } },
      });
      const terminalCount = seen.length;
      await engine.updateTask("t", {});
      await engine.cancelTask("t");
      await expect(engine.handle("t").progress("late")).rejects.toThrow();
      expect(seen).toHaveLength(terminalCount);
      // Close the former lifecycle too; close is idempotent on both stores.
      await former.close();
    });

    it.each(["failed", "cancelled"] as const)(
      "emits %s only on worker commit",
      async (status) => {
        const { engine } = setup();
        const seen: DetailedTask[] = [];
        await engine.createTask({ ttlMs: null });
        engine.onTaskChanged("t", (task) => {
          seen.push(task);
        });
        await engine.cancelTask("t");
        expect(seen).toEqual([]);
        if (status === "failed")
          await engine
            .handle("t")
            .fail({ code: -1, message: "failed", data: { detail: 2 } });
        else await engine.handle("t").cancelled("stopped");
        expect(seen).toHaveLength(1);
        expect(seen[0]?.status).toBe(status);
        conforms(seen[0]!);
      },
    );

    it("can answer input reentrantly without losing or exposing the answers", async () => {
      const { engine } = setup();
      await engine.createTask({ ttlMs: null });
      let updating: Promise<unknown> | undefined;
      engine.onTaskChanged("t", (task) => {
        conforms(task);
        if (task.status === "input_required")
          updating = engine.updateTask("t", { a: { roots: [] } });
      });
      expect(
        await engine.handle("t").requestInput({ a: { method: "roots/list" } }),
      ).toEqual({ a: { roots: [] } });
      await updating;
    });

    it("isolates snapshots, catches sync and async errors, and never retries observers as CAS", async () => {
      const { engine, store } = setup();
      await engine.createTask({ ttlMs: null });
      const update = vi.spyOn(store, "update");
      const error = new ConcurrentUpdateError("t", 1, 2);
      const reported = barrier();
      const errors: unknown[] = [];
      engine.onTaskChanged(
        "t",
        (task) => {
          if (task.status === "completed") task.result.changed = true;
          throw error;
        },
        {
          onError: (value) => {
            errors.push(value);
            throw new Error("reporter failed");
          },
        },
      );
      engine.onTaskChanged(
        "t",
        async () => {
          throw error;
        },
        {
          onError: (value) => {
            errors.push(value);
            reported.release();
            return Promise.reject(error);
          },
        },
      );
      const seen: DetailedTask[] = [];
      engine.onTaskChanged("t", (task) => {
        seen.push(task);
      });
      engine.onTaskChanged("t", () => {
        throw error;
      });
      await engine.handle("t").complete({ nested: { value: 1 } });
      await reported.promise;
      expect(update).toHaveBeenCalledTimes(1);
      expect(errors).toEqual([error, error]);
      expect(seen[0]).toEqual(await engine.getTask("t"));
      expect(seen[0]).not.toHaveProperty("result.changed");
    });

    it("contains projection failures after commit and does no projection without listeners", async () => {
      const { engine } = setup();
      await engine.createTask({ ttlMs: null });
      const projection = vi.spyOn(wire, "toDetailedTask");
      await engine.handle("t").progress("unobserved");
      expect(projection).not.toHaveBeenCalled();
      const failure = new Error("projection failed");
      const errors: unknown[] = [];
      engine.onTaskChanged("t", () => {}, {
        onError: (error) => {
          errors.push(error);
        },
      });
      projection.mockImplementationOnce(() => {
        throw failure;
      });
      await engine.handle("t").progress("committed");
      expect(errors).toEqual([failure]);
      expect((await engine.getTask("t")).statusMessage).toBe("committed");
    });

    it("uses a dispatch snapshot, independent registrations and idempotent unsubscribe", async () => {
      const { engine } = setup();
      await engine.createTask({ ttlMs: null });
      const calls: string[] = [];
      let offSecond = () => {};
      let first = true;
      const offFirst = engine.onTaskChanged("t", () => {
        calls.push("first");
        offSecond();
        if (first) {
          first = false;
          engine.onTaskChanged("t", () => {
            calls.push("new");
          });
        }
      });
      offSecond = engine.onTaskChanged("t", () => {
        calls.push("second");
      });
      await engine.handle("t").progress("one");
      expect(calls).toEqual(["first"]);
      offFirst();
      offFirst();
      await engine.handle("t").progress("two");
      expect(calls).toEqual(["first", "new"]);
      const callback = vi.fn();
      const off = engine.onTaskChanged("t", callback);
      engine.onTaskChanged("t", callback);
      off();
      off();
      await engine.handle("t").progress("three");
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it("does not let an old unsubscribe remove a newer group", async () => {
      const { engine } = setup();
      const off = engine.onTaskChanged("t", () => {});
      off();
      const listener = vi.fn();
      engine.onTaskChanged("t", listener);
      off();
      await engine.createTask({ ttlMs: null });
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("contains rejected writes and emits only the successful CAS retry", async () => {
      const { engine, store } = setup();
      await engine.createTask({ ttlMs: null });
      const seen = vi.fn();
      engine.onTaskChanged("t", seen);
      const update = store.update.bind(store);
      let attempts = 0;
      store.update = async (...args) => {
        attempts++;
        if (attempts === 1) throw new ConcurrentUpdateError("t", 0, 1);
        return update(...args);
      };
      await engine.handle("t").progress("retried");
      expect(attempts).toBe(2);
      expect(seen).toHaveBeenCalledTimes(1);
      store.update = async () => {
        throw new Error("write failed");
      };
      await expect(engine.handle("t").progress("not written")).rejects.toThrow(
        "write failed",
      );
      expect(seen).toHaveBeenCalledTimes(1);
      await expect(engine.createTask()).rejects.toThrow();
      expect(seen).toHaveBeenCalledTimes(1);
      store.update = async () => {
        throw new ConcurrentUpdateError("t", 1, 2);
      };
      await expect(engine.handle("t").progress("conflict")).rejects.toThrow();
      expect(seen).toHaveBeenCalledTimes(1);
    });

    it("suppresses expired commits, reads, sweeps and close, including backward clocks", async () => {
      const { engine, store, setTime } = setup();
      await engine.createTask({ ttlMs: 100 });
      const seen = vi.fn();
      engine.onTaskChanged("t", seen);
      await engine.handle("t").progress("same clock");
      setTime(START - 1);
      await engine.handle("t").progress("clock back");
      expect(seen.mock.calls[0]?.[0].lastUpdatedAt).toBe(
        seen.mock.calls[1]?.[0].lastUpdatedAt,
      );
      // A commit can shorten the TTL to an already elapsed boundary.
      setTime(START + 50);
      await engine.handle("t").progress("expired", { ttlMs: 1 });
      expect(seen).toHaveBeenCalledTimes(2);
      await expect(engine.getTask("t")).rejects.toThrow();
      await store.sweep();
      await engine.close();
      expect(seen).toHaveBeenCalledTimes(2);
      expect(() => engine.onTaskChanged("t", seen)).toThrow("closed");
    });

    it("notifies in observed order when store promises resolve in reverse commit order", async () => {
      const { engine, store } = setup();
      await engine.createTask({ ttlMs: null });
      const update = store.update.bind(store);
      const committed = barrier();
      const resume = barrier();
      let first = true;
      store.update = async (...args) => {
        const record = await update(...args);
        if (first) {
          first = false;
          committed.release();
          await resume.promise;
        }
        return record;
      };
      const seen: string[] = [];
      engine.onTaskChanged("t", (task) => {
        seen.push(task.statusMessage!);
      });
      const older = engine.handle("t").progress("older");
      await committed.promise;
      await engine.handle("t").progress("newer");
      resume.release();
      await older;
      expect(seen).toEqual(["newer", "older"]);
      expect((await engine.getTask("t")).statusMessage).toBe("newer");
    });

    it.each(["create", "update"] as const)(
      "suppresses a pending %s after close starts",
      async (method) => {
        const { engine, store } = setup();
        if (method === "update") await engine.createTask({ ttlMs: null });
        const reached = barrier();
        const resume = barrier();
        // Commit, then hold the acknowledgement; close cannot undo the durable write.
        if (method === "create") {
          const create = store.create.bind(store);
          store.create = async (...args) => {
            await create(...args);
            reached.release();
            await resume.promise;
          };
        } else {
          const update = store.update.bind(store);
          store.update = async (...args) => {
            const record = await update(...args);
            reached.release();
            await resume.promise;
            return record;
          };
        }
        const seen = vi.fn();
        engine.onTaskChanged("t", seen);
        const pending =
          method === "create"
            ? engine.createTask({ ttlMs: null })
            : engine.handle("t").progress("committed");
        await reached.promise;
        await engine.close();
        resume.release();
        await pending;
        expect(seen).not.toHaveBeenCalled();
      },
    );

    it("close during a callback skips later listeners and does not await callbacks", async () => {
      const { engine } = setup();
      await engine.createTask({ ttlMs: null });
      const never = new Promise<void>(() => {});
      let closing: Promise<void> | undefined;
      engine.onTaskChanged("t", () => {
        closing = engine.close();
        return never;
      });
      const later = vi.fn();
      engine.onTaskChanged("t", later);
      await engine.handle("t").progress("closing");
      await closing;
      expect(later).not.toHaveBeenCalled();
    });

    it("validates registrations before storing them", () => {
      const { engine } = setup();
      expect(() => engine.onTaskChanged(4 as never, () => {})).toThrow(
        TypeError,
      );
      expect(() => engine.onTaskChanged("t", null as never)).toThrow(TypeError);
      expect(() => engine.onTaskChanged("t", () => {}, null as never)).toThrow(
        TypeError,
      );
      expect(() =>
        engine.onTaskChanged("t", () => {}, { onError: 2 as never }),
      ).toThrow(TypeError);
    });
  });
}
