import {
  isConcurrentUpdateError,
  TaskAlreadyTerminalError,
  TaskNotFoundError,
} from "./errors.js";
import type { TaskPatch, TaskRecord, TaskStore } from "./types.js";
import { isTerminal } from "./wire.js";

/**
 * How many times a compare-and-swap is retried before giving up. Losing a race
 * is normal on a shared store; retrying forever would turn a persistent
 * conflict into a hung request.
 */
const CAS_ATTEMPTS = 5;

export interface MutationDecision<T> {
  patch: TaskPatch;
  afterCommit: T;
}

export type MutationOutcome<T> =
  | { record: TaskRecord; changed: false }
  | { record: TaskRecord; changed: true; afterCommit: T };

interface TaskMutatorOptions {
  store: TaskStore;
  now: () => number;
  /** Runs only after `store.update()` returned the committed record. */
  onCommitted: (record: TaskRecord) => void;
}

/**
 * The one durable mutation path shared by every lifecycle operation.
 *
 * It owns the persistence transaction — read, terminal guard, monotonic
 * timestamp, compare-and-swap and bounded retry — but makes no protocol-level
 * decisions. Callers decide the patch and any effect that becomes valid after
 * commit; worker coordination observes only the committed record.
 */
export class TaskMutator {
  readonly #store: TaskStore;
  readonly #now: () => number;
  readonly #onCommitted: (record: TaskRecord) => void;

  constructor(options: TaskMutatorOptions) {
    this.#store = options.store;
    this.#now = options.now;
    this.#onCommitted = options.onCommitted;
  }

  async mutate(
    taskId: string,
    change: (record: TaskRecord) => TaskPatch | undefined,
  ): Promise<TaskRecord> {
    const outcome = await this.mutateWithEffect(taskId, (record) => {
      const patch = change(record);
      return patch === undefined
        ? undefined
        : { patch, afterCommit: undefined };
    });
    return outcome.record;
  }

  async mutateWithEffect<T>(
    taskId: string,
    change: (record: TaskRecord) => MutationDecision<T> | undefined,
  ): Promise<MutationOutcome<T>> {
    let lastConflict: unknown;

    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      const record = await this.#store.get(taskId);
      if (record === undefined) throw new TaskNotFoundError(taskId);
      if (isTerminal(record.status)) {
        throw new TaskAlreadyTerminalError(taskId, record.status);
      }

      const decision = change(record);
      if (decision === undefined) return { record, changed: false };

      // Never decreases, even if the clock steps backwards or two writes land
      // inside the same millisecond.
      const previous = Date.parse(record.lastUpdatedAt);
      const stamped = Number.isNaN(previous)
        ? this.#now()
        : Math.max(this.#now(), previous);

      try {
        const updated = await this.#store.update(
          taskId,
          {
            ...decision.patch,
            lastUpdatedAt: new Date(stamped).toISOString(),
          },
          record.version,
        );
        this.#onCommitted(updated);
        return {
          record: updated,
          changed: true,
          afterCommit: decision.afterCommit,
        };
      } catch (error) {
        if (!isConcurrentUpdateError(error)) throw error;
        lastConflict = error;
      }
    }

    throw lastConflict;
  }
}
