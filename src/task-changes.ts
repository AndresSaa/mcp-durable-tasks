import { hasExpired } from "./record.js";
import type {
  TaskChangeListener,
  TaskChangeOptions,
  TaskRecord,
} from "./types.js";
import { toDetailedTask } from "./wire.js";

interface Subscription {
  listener: TaskChangeListener;
  onError: TaskChangeOptions["onError"];
}

/** Local observers only. The host owns subscriptions and delivery on the wire. */
export class TaskChanges {
  readonly #listeners = new Map<string, Set<Subscription>>();

  constructor(private readonly now: () => number) {}

  subscribe(
    taskId: string,
    listener: TaskChangeListener,
    options?: TaskChangeOptions,
  ): () => void {
    if (typeof taskId !== "string" || typeof listener !== "function") {
      throw new TypeError("onTaskChanged requires a taskId and listener");
    }
    if (
      options !== undefined &&
      (options === null ||
        (options.onError !== undefined &&
          typeof options.onError !== "function"))
    ) {
      throw new TypeError("onTaskChanged onError must be a function");
    }
    let group = this.#listeners.get(taskId);
    if (group === undefined) {
      group = new Set();
      this.#listeners.set(taskId, group);
    }
    const subscription = { listener, onError: options?.onError };
    group.add(subscription);
    return () => {
      group.delete(subscription);
      if (group.size === 0 && this.#listeners.get(taskId) === group) {
        this.#listeners.delete(taskId);
      }
    };
  }

  emit(record: TaskRecord): void {
    const group = this.#listeners.get(record.taskId);
    if (group === undefined) return;
    for (const subscription of [...group]) {
      if (this.#listeners.get(record.taskId) !== group) break;
      if (!group.has(subscription)) continue;
      try {
        if (hasExpired(record, this.now())) break;
        // Project separately for each listener: even synchronous mutation of
        // the first snapshot must not reach another observer or the store.
        const pending = subscription.listener(toDetailedTask(record));
        void Promise.resolve(pending).catch((error: unknown) =>
          report(subscription, error),
        );
      } catch (error) {
        report(subscription, error);
      }
    }
  }

  close(): void {
    for (const group of this.#listeners.values()) group.clear();
    this.#listeners.clear();
  }
}

function report(subscription: Subscription, error: unknown): void {
  try {
    // A JavaScript error handler can return a rejected promise despite the
    // void signature. Contain that too, without recursively reporting it.
    void Promise.resolve(subscription.onError?.(error)).catch(() => {});
  } catch {
    // Observing a durable write must never turn it into a failed write.
  }
}
