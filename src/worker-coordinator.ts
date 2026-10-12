import { TaskNotFoundError } from "./errors.js";
import type { InputResponses, TaskRecord } from "./types.js";
import { MAX_TIMER_MS } from "./validation.js";

interface Waiter {
  token: symbol;
  promise: Promise<InputResponses>;
  resolve: (responses: InputResponses) => void;
  reject: (error: unknown) => void;
  signal: AbortSignal;
  abortListener: () => void;
}

interface Expiry {
  expiresAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

export interface WaitRegistration {
  readonly taskId: string;
  readonly token: symbol;
  readonly promise: Promise<InputResponses>;
}

/**
 * Process-local coordination for the worker that owns a task.
 *
 * Durable state remains in TaskStore. These promises and AbortSignals only
 * make sense in the process where the worker is running, and are deliberately
 * isolated from the public TaskLifecycle surface.
 *
 * Everything held per task is released when the task ends through this
 * lifecycle, when it expires, or on `close()`. Expiry needs a timer because
 * nothing else would tell this process: a task cancelled here whose worker
 * never runs here (or ends elsewhere) gets no further committed write, and
 * `sweep()` is a store operation the lifecycle does not observe. Without it,
 * every such cancellation would keep its AbortController for the life of the
 * process.
 */
export class WorkerCoordinator {
  readonly #now: () => number;
  readonly #signals = new Map<string, AbortController>();
  readonly #waiters = new Map<string, Waiter>();
  readonly #expiries = new Map<string, Expiry>();

  constructor(now: () => number) {
    this.#now = now;
  }

  /** How many tasks hold process-local state. Internal, for leak tests. */
  get trackedTasks(): number {
    const ids = new Set([
      ...this.#signals.keys(),
      ...this.#waiters.keys(),
      ...this.#expiries.keys(),
    ]);
    return ids.size;
  }

  signalFor(taskId: string): AbortSignal {
    return this.#controller(taskId).signal;
  }

  register(taskId: string): WaitRegistration {
    if (this.#waiters.has(taskId)) {
      throw new Error(`Task ${taskId} is already awaiting input`);
    }

    const signal = this.signalFor(taskId);
    if (signal.aborted) throw signal.reason;

    const token = Symbol(taskId);
    let resolve!: (responses: InputResponses) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<InputResponses>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Registration precedes the durable write. Attach a rejection observer now
    // so cancellation during that write cannot become an unhandled rejection
    // before requestInput() returns the promise to its caller.
    void promise.catch(() => undefined);

    const abortListener = () => {
      this.#reject(taskId, token, signal.reason);
    };
    const waiter: Waiter = {
      token,
      promise,
      resolve,
      reject,
      signal,
      abortListener,
    };
    this.#waiters.set(taskId, waiter);
    signal.addEventListener("abort", abortListener, { once: true });

    return { taskId, token, promise };
  }

  rejectRegistration(registration: WaitRegistration, error: unknown): void {
    this.#reject(registration.taskId, registration.token, error);
  }

  resolve(taskId: string, responses: InputResponses): void {
    const waiter = this.#take(taskId);
    if (waiter !== undefined) waiter.resolve(structuredClone(responses));
  }

  finish(taskId: string, error: unknown): void {
    const waiter = this.#take(taskId);
    if (waiter !== undefined) waiter.reject(error);
    this.#signals.delete(taskId);
    this.#clearExpiry(taskId);
  }

  /**
   * Records cancellation intent for `record`'s task. The signal stays raised
   * for a worker that reads it later, until the task ends or expires.
   */
  abort(taskId: string, reason: unknown, record: TaskRecord): void {
    this.#controller(taskId).abort(reason);
    this.#trackExpiry(record);
  }

  observe(record: TaskRecord): void {
    if (
      record.status === "completed" ||
      record.status === "failed" ||
      record.status === "cancelled"
    ) {
      this.finish(
        record.taskId,
        new Error(
          `Task ${record.taskId} became ${record.status} while awaiting input`,
        ),
      );
      return;
    }

    // A committed write may have revised the TTL. Only tasks that already
    // hold local state are tracked; anything else has nothing to release.
    if (this.#signals.has(record.taskId) || this.#waiters.has(record.taskId)) {
      this.#trackExpiry(record);
    }
  }

  close(error: unknown): void {
    const taskIds = [...this.#waiters.keys()];
    for (const taskId of taskIds) this.finish(taskId, error);
    this.#signals.clear();
    for (const taskId of [...this.#expiries.keys()]) this.#clearExpiry(taskId);
  }

  /**
   * One timer per tracked task, at `createdAt + ttlMs` by the injected clock.
   * If it fires before that clock agrees (a test clock, or one that stepped
   * back), it re-arms instead of releasing a live task.
   */
  #trackExpiry(record: TaskRecord): void {
    const { taskId } = record;
    this.#clearExpiry(taskId);
    if (record.ttlMs === null) return;
    const createdAt = Date.parse(record.createdAt);
    if (Number.isNaN(createdAt)) return;

    const expiry: Expiry = { expiresAt: createdAt + record.ttlMs };
    this.#expiries.set(taskId, expiry);
    const schedule = () => {
      if (this.#expiries.get(taskId) !== expiry) return;
      const remaining = expiry.expiresAt - this.#now();
      if (remaining <= 0) {
        this.#expired(taskId);
        return;
      }
      expiry.timer = setTimeout(schedule, Math.min(remaining, MAX_TIMER_MS));
      expiry.timer.unref?.();
    };
    schedule();
  }

  #expired(taskId: string): void {
    const waiter = this.#waiters.get(taskId);
    if (waiter !== undefined) {
      this.#reject(taskId, waiter.token, new TaskNotFoundError(taskId));
    }
    this.#signals.delete(taskId);
    this.#clearExpiry(taskId);
  }

  #clearExpiry(taskId: string): void {
    const expiry = this.#expiries.get(taskId);
    if (expiry === undefined) return;
    if (expiry.timer !== undefined) clearTimeout(expiry.timer);
    this.#expiries.delete(taskId);
  }

  #reject(taskId: string, token: symbol, error: unknown): void {
    const waiter = this.#waiters.get(taskId);
    if (waiter?.token !== token) return;
    this.#take(taskId)?.reject(error);
  }

  #take(taskId: string): Waiter | undefined {
    const waiter = this.#waiters.get(taskId);
    if (waiter === undefined) return undefined;
    this.#waiters.delete(taskId);
    waiter.signal.removeEventListener("abort", waiter.abortListener);
    return waiter;
  }

  #controller(taskId: string): AbortController {
    let controller = this.#signals.get(taskId);
    if (controller === undefined) {
      controller = new AbortController();
      this.#signals.set(taskId, controller);
    }
    return controller;
  }
}
