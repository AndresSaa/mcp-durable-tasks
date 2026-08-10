import {
  DuplicateInputKeyError,
  TaskAlreadyTerminalError,
  TaskCancelled,
  TaskNotFoundError,
} from "./errors.js";
import { createTaskHandle, type TaskWriter } from "./handle.js";
import { mergeInputResponses } from "./input-round.js";
import type {
  CancelTaskResult,
  CreateTaskResult,
  GetTaskResult,
  InputRequest,
  InputRequests,
  InputResponses,
  TaskHandle,
  TaskLifecycleOptions,
  TaskPatch,
  TaskRecord,
  UpdateTaskResult,
} from "./types.js";
import {
  TaskMutator,
  type MutationDecision,
  type MutationOutcome,
} from "./task-mutator.js";
import { isTerminal, toCreateTaskResult, toDetailedTask } from "./wire.js";
import { assertTtlMs } from "./validation.js";
import { WorkerCoordinator } from "./worker-coordinator.js";

const DEFAULT_TTL_MS = 3_600_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

/**
 * The state machine. Holds no task data of its own — the store owns that — but
 * process-local worker coordination lives in `WorkerCoordinator`; after a crash
 * the worker is gone too, while the durable task record remains in the store.
 */
export class TaskLifecycle {
  readonly #store: TaskLifecycleOptions["store"];
  readonly #defaultTtlMs: number | null;
  readonly #defaultPollIntervalMs: number | undefined;
  readonly #now: () => number;
  readonly #generateTaskId: () => string;

  readonly #workers: WorkerCoordinator;
  readonly #mutator: TaskMutator;
  #sweeper: ReturnType<typeof setInterval> | undefined;
  #closed = false;

  constructor(options: TaskLifecycleOptions) {
    this.#store = options.store;
    this.#defaultTtlMs =
      options.defaultTtlMs === undefined
        ? DEFAULT_TTL_MS
        : options.defaultTtlMs;
    assertTtlMs(this.#defaultTtlMs, "defaultTtlMs");
    this.#defaultPollIntervalMs =
      options.defaultPollIntervalMs === null
        ? undefined
        : (options.defaultPollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    this.#now = options.now ?? Date.now;
    this.#workers = new WorkerCoordinator(this.#now);
    this.#mutator = new TaskMutator({
      store: this.#store,
      now: this.#now,
      onCommitted: (record) => this.#workers.observe(record),
    });
    this.#generateTaskId = options.generateTaskId ?? defaultTaskId;

    this.#startSweeper(options.sweepIntervalMs);
  }

  #startSweeper(intervalMs: number | null | undefined): void {
    if (intervalMs === null || intervalMs === undefined) return;
    this.#sweeper = setInterval(() => {
      void this.#store.sweep(this.#now()).catch(() => {
        // A failed sweep drops nothing and loses nothing; the next one tries
        // again. Throwing out of a timer would take the process down for a
        // housekeeping error.
      });
    }, intervalMs);
    // Housekeeping must never be the reason a process stays alive.
    this.#sweeper.unref?.();
  }

  /**
   * I1: does not resolve until `store.create()` has, which is the store's
   * promise that a subsequent `get()` would find the task. The extension states
   * this normatively — a server MUST NOT return `CreateTaskResult` before a
   * `tasks/get` for that ID would resolve.
   */
  async createTask(init?: {
    ttlMs?: number | null;
    pollIntervalMs?: number;
    statusMessage?: string;
  }): Promise<CreateTaskResult> {
    this.#assertOpen();
    const timestamp = new Date(this.#now()).toISOString();
    const pollIntervalMs = init?.pollIntervalMs ?? this.#defaultPollIntervalMs;
    const ttlMs = init?.ttlMs === undefined ? this.#defaultTtlMs : init.ttlMs;
    assertTtlMs(ttlMs, "createTask() ttlMs");

    const record: TaskRecord = {
      taskId: this.#generateTaskId(),
      status: "working",
      createdAt: timestamp,
      lastUpdatedAt: timestamp,
      ttlMs,
      ...(pollIntervalMs !== undefined && { pollIntervalMs }),
      ...(init?.statusMessage !== undefined && {
        statusMessage: init.statusMessage,
      }),
      version: 0,
    };

    await this.#store.create(record);
    return toCreateTaskResult(record);
  }

  /** The handle a worker writes through. */
  handle(taskId: string): TaskHandle {
    const writer: TaskWriter = {
      mutate: (id, change) => this.#mutate(id, change),
      signalFor: (id) => this.#workers.signalFor(id),
      requestInput: (id, requests) => this.#requestInput(id, requests),
    };
    return createTaskHandle(taskId, writer);
  }

  /**
   * Serves `tasks/get`. **Pure read (I3):** nothing here writes, not even
   * `lastUpdatedAt`, and no sweep is triggered as a side effect. The extension
   * separates reads from writes so reads stay idempotent and cacheable.
   */
  async getTask(taskId: string): Promise<GetTaskResult> {
    const record = await this.#store.get(taskId);
    if (record === undefined) throw new TaskNotFoundError(taskId);
    return toDetailedTask(record);
  }

  /**
   * Serves `tasks/update`. Returns an empty acknowledgement.
   *
   * Keys that are not currently outstanding — never issued, already answered,
   * or superseded — are **ignored, not rejected**, which is what the extension
   * asks for. A mixed update applies the good keys and drops the rest.
   */
  async updateTask(
    taskId: string,
    inputResponses: Record<string, unknown>,
  ): Promise<UpdateTaskResult> {
    this.#assertOpen();

    let settled: InputResponses | undefined;

    try {
      settled = await this.#applyInputResponses(taskId, inputResponses);
    } catch (error) {
      // A terminal task has no outstanding keys, so *every* key in the update
      // is one the server should ignore — which makes this an empty
      // acknowledgement, not an error. Letting TaskAlreadyTerminalError out
      // here would answer a conforming client with a failure for doing
      // something the extension explicitly allows: racing a late response
      // against a task that just finished.
      if (!(error instanceof TaskAlreadyTerminalError)) throw error;
    }

    if (settled !== undefined) {
      this.#workers.resolve(taskId, settled);
    }
    return { resultType: "complete" };
  }

  async #applyInputResponses(
    taskId: string,
    inputResponses: Record<string, unknown>,
  ): Promise<InputResponses | undefined> {
    const outcome = await this.#mutateWithEffect(taskId, (record) => {
      if (record.status !== "input_required") return undefined;

      const merge = mergeInputResponses(
        record.inputRequests ?? {},
        record.inputResponses,
        inputResponses,
      );
      if (merge === undefined) return undefined;

      if (!merge.complete) {
        // Partial answers are legal and keep the task parked.
        return {
          patch: { inputResponses: merge.responses },
          afterCommit: undefined,
        };
      }

      return {
        patch: {
          status: "working",
          inputRequests: undefined,
          inputResponses: undefined,
        },
        afterCommit: merge.responses,
      };
    });

    return outcome.changed ? outcome.afterCommit : undefined;
  }

  /**
   * Serves `tasks/cancel`. Empty acknowledgement, and **cooperative**: this
   * raises the worker's signal and changes no status.
   *
   * That is the specified behaviour, not a shortcut — cancellation is
   * eventually consistent, the status MAY stay non-terminal after the ack, and
   * the task MAY end somewhere other than `cancelled` if the work finished
   * first. A worker that honours the signal calls `fail()` or `complete()`;
   * one that ignores it leaves the task to its TTL.
   */
  async cancelTask(taskId: string): Promise<CancelTaskResult> {
    this.#assertOpen();
    const record = await this.#store.get(taskId);
    if (record === undefined) throw new TaskNotFoundError(taskId);
    if (!isTerminal(record.status)) {
      this.#workers.abort(taskId, new TaskCancelled(taskId));
    }
    return { resultType: "complete" };
  }

  /** Stops the sweeper and wakes every parked worker. Idempotent. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#sweeper !== undefined) clearInterval(this.#sweeper);

    this.#workers.close(
      new Error("TaskLifecycle was closed while awaiting input"),
    );
    await this.#store.close();
  }

  /* -- TaskWriter, used by the handle ------------------------------------ */

  async #requestInput(
    taskId: string,
    requests: Record<string, InputRequest>,
  ): Promise<InputResponses> {
    const registration = this.#workers.register(taskId);
    const keys = Object.keys(requests);

    try {
      await this.#mutate(taskId, (record) => {
        const used = new Set(record.usedInputKeys ?? []);
        for (const key of keys) {
          if (used.has(key)) throw new DuplicateInputKeyError(taskId, key);
          used.add(key);
        }
        return {
          status: "input_required",
          inputRequests: structuredClone(requests) as InputRequests,
          inputResponses: {},
          usedInputKeys: [...used],
        };
      });
    } catch (error) {
      this.#workers.rejectRegistration(registration, error);
      throw error;
    }

    return registration.promise;
  }

  /**
   * Read, decide, compare-and-swap, retry. The single write path: terminality
   * (I2) and monotonic `lastUpdatedAt` (I4) are enforced here so no caller can
   * forget them.
   */
  async #mutate(
    taskId: string,
    change: (record: TaskRecord) => TaskPatch | undefined,
  ): Promise<TaskRecord> {
    return this.#observeUnavailable(taskId, () =>
      this.#mutator.mutate(taskId, change),
    );
  }

  async #mutateWithEffect<T>(
    taskId: string,
    change: (record: TaskRecord) => MutationDecision<T> | undefined,
  ): Promise<MutationOutcome<T>> {
    return this.#observeUnavailable(taskId, () =>
      this.#mutator.mutateWithEffect(taskId, change),
    );
  }

  async #observeUnavailable<T>(
    taskId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (
        error instanceof TaskNotFoundError ||
        error instanceof TaskAlreadyTerminalError
      ) {
        this.#workers.finish(taskId, error);
      }
      throw error;
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("TaskLifecycle is closed");
  }
}

/**
 * I6: task IDs are effectively bearer tokens for the stored state, so they come
 * from a CSPRNG. Never a counter, a timestamp, or a hash of the arguments —
 * any of those makes tasks enumerable, and the extension dropped `tasks/list`
 * precisely so they would not be.
 */
function defaultTaskId(): string {
  return crypto.randomUUID();
}
