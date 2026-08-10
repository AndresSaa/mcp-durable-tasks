import { ConcurrentUpdateError } from "./errors.js";
import { applyPatch, hasExpired, snapshot } from "./record.js";
import type { TaskPatch, TaskRecord, TaskStore } from "./types.js";

/**
 * An in-process `TaskStore`: tests, development, and servers whose tasks need
 * not outlive the process.
 *
 * It uses no Node built-ins, deliberately. This is the store that proves the
 * engine runs in web-standard runtimes — Workers, Deno, Bun — where `node:fs`
 * does not resolve. `WalTaskStore` is the one allowed to be Node-only.
 *
 * It satisfies I1 vacuously: "durable enough that a later `get()` finds it"
 * is true the moment the map is written, because this store's durability
 * boundary is the process itself. That is not a loophole — it is the honest
 * statement of what in-memory storage guarantees, and it is why the crash
 * tests run against `WalTaskStore`.
 */
export class MemoryTaskStore implements TaskStore {
  readonly #tasks = new Map<string, TaskRecord>();
  readonly #now: () => number;
  #closed = false;

  /**
   * The clock is injectable because TTL expiry is otherwise untestable without
   * sleeping, and a test that sleeps for an hour is a test nobody runs. Only
   * `sweep()` takes a timestamp in the `TaskStore` interface, and widening
   * `get()` to take one would put a testing concern into the contract every
   * third-party store has to implement.
   */
  constructor(options?: { now?: () => number }) {
    this.#now = options?.now ?? Date.now;
  }

  async create(record: TaskRecord): Promise<void> {
    this.#assertOpen();
    if (this.#tasks.has(record.taskId)) {
      throw new Error(`Task ${record.taskId} already exists`);
    }
    this.#tasks.set(record.taskId, snapshot(record));
  }

  async get(taskId: string): Promise<TaskRecord | undefined> {
    this.#assertOpen();
    const record = this.#tasks.get(taskId);
    if (record === undefined) return undefined;
    // An expired task is indistinguishable from a missing one. Sweeping is
    // housekeeping; expiry is a read-time fact, so a store that has not swept
    // recently still answers correctly.
    return hasExpired(record, this.#now()) ? undefined : snapshot(record);
  }

  async update(
    taskId: string,
    patch: TaskPatch,
    expectedVersion: number,
  ): Promise<TaskRecord> {
    this.#assertOpen();
    const current = this.#tasks.get(taskId);
    if (current === undefined || hasExpired(current, this.#now())) {
      throw new ConcurrentUpdateError(taskId, expectedVersion, undefined);
    }
    if (current.version !== expectedVersion) {
      throw new ConcurrentUpdateError(taskId, expectedVersion, current.version);
    }

    const updated = applyPatch(current, patch);
    this.#tasks.set(taskId, updated);
    return snapshot(updated);
  }

  async sweep(now = this.#now()): Promise<number> {
    this.#assertOpen();
    let removed = 0;
    for (const [taskId, record] of this.#tasks) {
      if (hasExpired(record, now)) {
        this.#tasks.delete(taskId);
        removed += 1;
      }
    }
    // A count, never the records (I7). Returning what was dropped would hand
    // a caller a list of tasks it never created.
    return removed;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#tasks.clear();
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("MemoryTaskStore is closed");
  }
}
