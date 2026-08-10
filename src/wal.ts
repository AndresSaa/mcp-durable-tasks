import { createWal } from "process-wal";
import { debuglog } from "node:util";
import {
  ConcurrentUpdateError,
  isTaskEntryTooLargeError,
  TaskEntryTooLargeError,
} from "./errors.js";
import { applyPatch, hasExpired, snapshot } from "./record.js";
import type { TaskPatch, TaskRecord, TaskStore } from "./types.js";

/**
 * A `TaskStore` that survives the process, on top of
 * [`process-wal`](https://github.com/AndresSaa/process-wal).
 *
 * The design is the usual one for a small durable map: an in-memory index is
 * the read path, and every mutation is appended to a log first. On open the
 * log replays into the index. `process-wal` is synchronous and
 * durable-before-return, which is what makes I1 hold — `create()` cannot
 * resolve before the record has reached the configured durability boundary.
 *
 * **This is the entry point that is allowed to be Node-only.** It is also the
 * one that needs `process-wal`, which is an optional peer dependency: anyone
 * who only wants `MemoryTaskStore` must not be made to install it.
 *
 * ## Where the durability boundary actually is
 *
 * With the default `fsync: false`, a returned `create()` means the record
 * reached the kernel page cache. That survives `SIGKILL`, a crash, a deploy and
 * a container restart — it does not survive the host losing power. Pass
 * `fsync: true` to move the boundary to storage, at roughly two orders of
 * magnitude more cost per write. Neither choice is hidden: I1 is a promise
 * about the boundary you selected, not about surviving everything.
 *
 * ## One process, one directory
 *
 * `process-wal` is single-writer and does not lock. Two processes on the same
 * directory corrupt the log. That is the same constraint the engine's worker
 * affinity already implies, and it is why this store fits stdio MCP servers —
 * Claude Code, Cursor, VS Code, a local Codex — where the long tasks actually
 * live. For a stateless HTTP server behind a load balancer, implement
 * `TaskStore` over your shared database instead; it is five methods.
 */

/** What goes in the log. Full-record writes, so replay is last-write-wins. */
type LogEntry =
  | { readonly t: "put"; readonly record: TaskRecord }
  | { readonly t: "del"; readonly taskId: string };

const debug = debuglog("mcp-durable-tasks");

export interface WalCompactionErrorEvent {
  /** The error raised by the automatic snapshot/checkpoint/compact attempt. */
  readonly error: unknown;
  /**
   * Whether `process-wal` rejected its health probe with
   * `ERR_WAL_UNUSABLE`. The mutation that triggered compaction is already
   * durable either way; an unusable WAL is surfaced on the next operation.
   */
  readonly walUnusable: boolean;
}

export interface WalTaskStoreOptions {
  /** Directory holding `wal.jsonl` and `wal.checkpoint`. Must not be shared. */
  dir: string;
  /** `true` moves the durability boundary from the page cache to storage. */
  fsync?: boolean;
  /**
   * Rewrite the log once it holds this many superseded entries. Each mutation
   * appends a whole record, so a long-lived task's history is almost entirely
   * dead weight; this is what bounds it. `null` disables automatic rewriting.
   */
  compactEvery?: number | null;
  /**
   * Observes a failed automatic compaction after the triggering mutation has
   * already committed. Exceptions thrown by the observer are debug-logged and
   * never change the mutation's outcome.
   */
  onCompactionError?: (event: WalCompactionErrorEvent) => void;
  /**
   * Largest single record the log will accept, in bytes.
   *
   * Defaults to 8 MiB for this task-oriented layer. That is enough for roughly
   * 100,000 ordinary 80-byte build-log lines while retaining a hard per-task
   * bound: the whole record is synchronously JSON-encoded and is copied again
   * during snapshot compaction, so making the default effectively unbounded
   * would merely trade a clear rejection for memory and event-loop pressure.
   * The limit includes the WAL envelope and task metadata, not just `result`.
   * Oversized writes throw `TaskEntryTooLargeError` with the stable
   * `ERR_ENTRY_TOO_LARGE` code before the task mutation commits.
   */
  maxEntryBytes?: number;
  /** Injectable clock, for TTL. Tests use it; nothing else should. */
  now?: () => number;
}

const DEFAULT_COMPACT_EVERY = 1_000;
/** Default per-record WAL write limit: 8 MiB. */
export const DEFAULT_MAX_ENTRY_BYTES = 8 * 1024 * 1024;

export class WalTaskStore implements TaskStore {
  readonly #wal: ReturnType<typeof createWal<LogEntry>>;
  readonly #tasks = new Map<string, TaskRecord>();
  readonly #now: () => number;
  readonly #compactEvery: number | null;
  readonly #maxEntryBytes: number;
  readonly #onCompactionError:
    ((event: WalCompactionErrorEvent) => void) | undefined;
  #closed = false;
  #pendingWalFailure: { readonly error: unknown } | undefined;

  constructor(options: WalTaskStoreOptions) {
    this.#now = options.now ?? Date.now;
    this.#compactEvery =
      options.compactEvery === undefined
        ? DEFAULT_COMPACT_EVERY
        : options.compactEvery;
    this.#onCompactionError = options.onCompactionError;
    this.#maxEntryBytes = options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;

    this.#wal = createWal<LogEntry>({
      dir: options.dir,
      fsync: options.fsync ?? false,
      maxEntryBytes: this.#maxEntryBytes,
    });

    this.#replay();
  }

  async create(record: TaskRecord): Promise<void> {
    this.#assertOpen();
    if (this.#tasks.has(record.taskId)) {
      throw new Error(`Task ${record.taskId} already exists`);
    }
    // Validate and detach before the append. Otherwise JSON encoding could
    // change a value (Map -> {}, Date -> string) and make live state disagree
    // with replay, or the post-append snapshot could reject and leave a ghost
    // record after create() reported failure.
    const stored = snapshot(record);
    // Durable first, indexed second. The other order would let a `get()`
    // between the two calls answer for a task the log does not yet carry —
    // which is precisely the acknowledgement-before-durability failure I1
    // exists to forbid.
    this.#write(record.taskId, () =>
      this.#wal.append({ t: "put", record: stored }),
    );
    this.#tasks.set(record.taskId, stored);
  }

  async get(taskId: string): Promise<TaskRecord | undefined> {
    this.#assertOpen();
    const record = this.#tasks.get(taskId);
    if (record === undefined) return undefined;
    // Deep copy on the way out, same as MemoryTaskStore: a caller that
    // mutated a nested `result` in place would change stored state behind the
    // compare-and-swap, with no version bump and nothing written to the log.
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

    const next = applyPatch(current, patch);
    this.#write(taskId, () => this.#wal.append({ t: "put", record: next }));
    this.#tasks.set(taskId, next);
    this.#maybeCompact();
    return snapshot(next);
  }

  async sweep(now = this.#now()): Promise<number> {
    this.#assertOpen();
    const expired: string[] = [];
    for (const [taskId, record] of this.#tasks) {
      if (hasExpired(record, now)) expired.push(taskId);
    }
    if (expired.length === 0) return 0;

    // One batch: `appendMany` pays a single flush for the whole sweep, and a
    // crash midway replays as a partial sweep, which is harmless — the
    // survivors are expired anyway and the next sweep takes them.
    this.#write(undefined, () =>
      this.#wal.appendMany(
        expired.map((taskId) => ({ t: "del", taskId }) as const),
      ),
    );
    for (const taskId of expired) this.#tasks.delete(taskId);
    this.#maybeCompact();
    // A count, never the records (I7).
    return expired.length;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#tasks.clear();
    this.#wal.close();
  }

  /**
   * Rewrites the log as a snapshot of live tasks, then drops everything before
   * it.
   *
   * The obvious alternative — checkpointing a task the moment it reaches a
   * terminal status — is wrong, and quietly so. `replay()` only returns entries
   * *after* the checkpoint, so checkpointing a completed task would erase its
   * result on the next open, while I8 requires a terminal task to keep that
   * result until its TTL elapses. Completion is not the point at which a task
   * stops being needed; expiry is.
   *
   * So the checkpoint has to follow the snapshot rather than individual tasks:
   * append the current state of everything still live, then mark every entry
   * before it processed, then compact.
   */
  compact(): void {
    this.#assertOpen();
    const now = this.#now();
    const live = [...this.#tasks.values()].filter(
      (record) => !hasExpired(record, now),
    );

    if (live.length === 0) {
      // Nothing to preserve: checkpoint past the whole log and reclaim it.
      this.#wal.checkpoint(this.#wal.stats().lastSeq);
      this.#tasks.clear();
      this.#wal.compact();
      return;
    }

    const seqs = this.#write(undefined, () =>
      this.#wal.appendMany(
        live.map((record) => ({ t: "put", record }) as const),
      ),
    );
    // Everything strictly before the snapshot is now superseded by it.
    this.#wal.checkpoint(seqs[0] - 1);
    this.#wal.compact();
  }

  #maybeCompact(): void {
    if (this.#compactEvery === null) return;
    const { pendingEntries } = this.#wal.stats();
    // Entries beyond one per live task are superseded history.
    if (pendingEntries - this.#tasks.size >= this.#compactEvery) {
      try {
        this.compact();
      } catch (error) {
        // The caller's append completed before automatic compaction began, so
        // propagating this error would report a durable mutation as failed. A
        // snapshot write can nevertheless poison process-wal. Probe it now,
        // remember that terminal condition, and surface it on the *next*
        // operation without changing the outcome of the committed one.
        let walFailure: unknown;
        try {
          this.#wal.stats();
        } catch (healthError) {
          walFailure = healthError;
          this.#pendingWalFailure = { error: healthError };
        }

        const event: WalCompactionErrorEvent = {
          error,
          walUnusable: walFailure !== undefined,
        };
        debug(
          "automatic compaction failed (walUnusable=%s): %O",
          event.walUnusable,
          error,
        );
        try {
          this.#onCompactionError?.(event);
        } catch (observerError) {
          debug("onCompactionError observer threw: %O", observerError);
        }
      }
    }
  }

  #replay(): void {
    for (const { value } of this.#wal.replay()) {
      if (value.t === "del") {
        this.#tasks.delete(value.taskId);
        continue;
      }
      this.#tasks.set(value.record.taskId, snapshot(value.record));
    }

    // A task whose TTL elapsed while the process was down never becomes
    // visible again. Dropping it here rather than at read time keeps the
    // index and a later `sweep()` count honest.
    const now = this.#now();
    for (const [taskId, record] of this.#tasks) {
      if (hasExpired(record, now)) this.#tasks.delete(taskId);
    }
  }

  #write<T>(taskId: string | undefined, operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (isTaskEntryTooLargeError(error)) {
        throw new TaskEntryTooLargeError(this.#maxEntryBytes, taskId, error);
      }
      throw error;
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("WalTaskStore is closed");
    if (this.#pendingWalFailure !== undefined) {
      throw this.#pendingWalFailure.error;
    }
  }
}
