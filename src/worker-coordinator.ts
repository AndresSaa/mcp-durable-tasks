import { TaskNotFoundError } from "./errors.js";
import type { InputResponses, TaskRecord } from "./types.js";

const MAX_TIMEOUT_MS = 2_147_483_647;

interface Waiter {
  token: symbol;
  promise: Promise<InputResponses>;
  resolve: (responses: InputResponses) => void;
  reject: (error: unknown) => void;
  signal: AbortSignal;
  abortListener: () => void;
  expiryTimer?: ReturnType<typeof setTimeout>;
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
 */
export class WorkerCoordinator {
  readonly #now: () => number;
  readonly #signals = new Map<string, AbortController>();
  readonly #waiters = new Map<string, Waiter>();

  constructor(now: () => number) {
    this.#now = now;
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
  }

  abort(taskId: string, reason: unknown): void {
    this.#controller(taskId).abort(reason);
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

    if (record.status === "input_required") this.#armExpiry(record);
  }

  close(error: unknown): void {
    const taskIds = [...this.#waiters.keys()];
    for (const taskId of taskIds) this.finish(taskId, error);
    this.#signals.clear();
  }

  #armExpiry(record: TaskRecord): void {
    const waiter = this.#waiters.get(record.taskId);
    if (waiter === undefined) return;
    if (waiter.expiryTimer !== undefined) clearTimeout(waiter.expiryTimer);
    waiter.expiryTimer = undefined;
    if (record.ttlMs === null) return;

    const createdAt = Date.parse(record.createdAt);
    if (Number.isNaN(createdAt)) return;
    const expiresAt = createdAt + record.ttlMs;
    const schedule = () => {
      const current = this.#waiters.get(record.taskId);
      if (current?.token !== waiter.token) return;
      const remaining = expiresAt - this.#now();
      if (remaining <= 0) {
        this.#reject(
          record.taskId,
          waiter.token,
          new TaskNotFoundError(record.taskId),
        );
        this.#signals.delete(record.taskId);
        return;
      }
      current.expiryTimer = setTimeout(
        schedule,
        Math.min(remaining, MAX_TIMEOUT_MS),
      );
      current.expiryTimer.unref?.();
    };
    schedule();
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
    if (waiter.expiryTimer !== undefined) clearTimeout(waiter.expiryTimer);
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
