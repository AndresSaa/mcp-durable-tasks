import { TaskNotFoundError } from "./errors.js";
import { hasExpired } from "./record.js";
import type { InputResponses, TaskRecord } from "./types.js";
import { MAX_TIMER_MS } from "./validation.js";
import { isTerminal } from "./wire.js";

/** The first delay before an unknown re-check is read again; it doubles. */
export const RETRY_FIRST_MS = 1_000;
/** The longest delay between re-check reads. */
export const RETRY_MAX_MS = 30_000;

interface Waiter {
  token: symbol;
  /** The keys of the round this waiter asked for. */
  keys: ReadonlySet<string>;
  /** Its own round has committed, so a reply may be delivered to it. */
  armed: boolean;
  /** A reply completed its round before it was armed; the answers were kept. */
  missed: boolean;
  promise: Promise<InputResponses>;
  resolve: (responses: InputResponses) => void;
  reject: (error: unknown) => void;
  signal: AbortSignal;
  abortListener: () => void;
}

interface Expiry {
  /** The version of the record this expiry was computed from. */
  version: number;
  /** `undefined` when the record never expires here (no TTL, bad date). */
  expiresAt?: number;
  timer?: ReturnType<typeof setTimeout>;
}

export interface WaitRegistration {
  readonly taskId: string;
  readonly token: symbol;
  readonly promise: Promise<InputResponses>;
}

/** A pure read of the current record, used to arm an expiry. */
export type RecordLookup = (taskId: string) => Promise<TaskRecord | undefined>;

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
 *
 * At expiry the signal is aborted, not just dropped, so a worker that holds it
 * learns that its task is gone. The reason is the `TaskNotFoundError` the task
 * now reads as everywhere else. A signal already raised by a cancellation keeps
 * its first reason. This is cooperative and writes nothing. Another instance
 * may have revised the TTL without this one seeing it, so the expiry is first
 * confirmed with one pure read. While the store cannot answer that read, the
 * task is kept and read again later, until the task ends or `close()`.
 */
export class WorkerCoordinator {
  readonly #now: () => number;
  readonly #lookup: RecordLookup | undefined;
  readonly #signals = new Map<string, AbortController>();
  readonly #waiters = new Map<string, Waiter>();
  readonly #expiries = new Map<string, Expiry>();
  #closed = false;

  constructor(now: () => number, lookup?: RecordLookup) {
    this.#now = now;
    this.#lookup = lookup;
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

  /**
   * Whether an armed waiter here asked for exactly the round with these keys.
   * A waiter whose own round has not committed yet is not a delivery target:
   * its write may still fail (a spent key, a lost race), and answers handed
   * to it would then be lost.
   */
  awaits(taskId: string, keys: readonly string[]): boolean {
    const waiter = this.#waiters.get(taskId);
    return waiter !== undefined && waiter.armed && sameKeys(waiter.keys, keys);
  }

  /**
   * Marks a registration's round as committed. Returns true if a reply
   * completed that round first, so its answers are waiting to be claimed.
   */
  arm(registration: WaitRegistration): boolean {
    const waiter = this.#waiters.get(registration.taskId);
    if (waiter?.token !== registration.token) return false;
    waiter.armed = true;
    return waiter.missed;
  }

  /**
   * Called after a reply's answers were kept because no armed waiter asked
   * for its round. If a waiter for that round exists and is armed by now, it
   * is returned so the caller can claim the answers for it; if it is not
   * armed yet, it is marked so that `arm()` reports it.
   */
  missed(
    taskId: string,
    keys: readonly string[],
  ): WaitRegistration | undefined {
    const waiter = this.#waiters.get(taskId);
    if (waiter === undefined || !sameKeys(waiter.keys, keys)) return undefined;
    if (!waiter.armed) {
      waiter.missed = true;
      return undefined;
    }
    return { taskId, token: waiter.token, promise: waiter.promise };
  }

  register(taskId: string, keys: readonly string[]): WaitRegistration {
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
      keys: new Set(keys),
      armed: false,
      missed: false,
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

  /**
   * Hands a completed round to the armed waiter that asked for it, and
   * returns whether it did. A waiter for a different round is left alone:
   * those answers are not the ones it asked for.
   */
  resolve(taskId: string, responses: InputResponses): boolean {
    if (!this.awaits(taskId, Object.keys(responses))) return false;
    this.#take(taskId)?.resolve(structuredClone(responses));
    return true;
  }

  finish(taskId: string, error: unknown): void {
    const waiter = this.#take(taskId);
    if (waiter !== undefined) waiter.reject(error);
    this.#signals.delete(taskId);
    this.#clearExpiry(taskId);
  }

  /**
   * The store no longer has the task: its TTL elapsed by the store's clock
   * before this lifecycle's timer fired, or another instance's TTL revision
   * was never seen here. Treated exactly like a local expiry.
   */
  gone(taskId: string, error: TaskNotFoundError): void {
    this.#expired(taskId, error);
  }

  /**
   * Records cancellation intent for `record`'s task. The signal stays raised
   * for a worker that reads it later, until the task ends or expires.
   */
  abort(taskId: string, reason: unknown, record: TaskRecord): void {
    // The caller already holds the record, so no lookup is needed to arm it.
    this.#controller(taskId, false).abort(reason);
    this.#trackExpiry(record);
  }

  observe(record: TaskRecord): void {
    if (isTerminal(record.status)) {
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
    this.#closed = true;
    const taskIds = [...this.#waiters.keys()];
    for (const taskId of taskIds) this.finish(taskId, error);
    this.#signals.clear();
    for (const taskId of [...this.#expiries.keys()]) this.#clearExpiry(taskId);
  }

  /**
   * One timer per tracked task, at `createdAt + ttlMs` by the injected clock.
   * If it fires before that clock agrees (a test clock, or one that stepped
   * back), it re-arms instead of releasing a live task.
   *
   * A record older than the one already tracked is ignored: a cancel or a
   * lookup may have read the record before a commit this coordinator already
   * observed, and its TTL would be stale.
   */
  #trackExpiry(record: TaskRecord): void {
    const { taskId } = record;
    const current = this.#expiries.get(taskId);
    if (current !== undefined && current.version > record.version) return;
    this.#clearExpiry(taskId);

    const expiry: Expiry = { version: record.version };
    this.#expiries.set(taskId, expiry);
    if (record.ttlMs === null) return;
    const createdAt = Date.parse(record.createdAt);
    if (Number.isNaN(createdAt)) return;

    expiry.expiresAt = createdAt + record.ttlMs;
    const expiresAt = expiry.expiresAt;
    const schedule = () => {
      if (this.#expiries.get(taskId) !== expiry) return;
      const remaining = expiresAt - this.#now();
      if (remaining <= 0) {
        this.#confirmExpiry(taskId, expiry);
        return;
      }
      expiry.timer = setTimeout(schedule, Math.min(remaining, MAX_TIMER_MS));
      expiry.timer.unref?.();
    };
    schedule();
  }

  /**
   * The tracked expiry has passed. One pure read (I3) decides: the task is
   * released only if the store no longer has it or its stored TTL has
   * elapsed by this clock; otherwise it is tracked again from that record.
   * Without a lookup, it is released.
   *
   * A read that fails or throws decides nothing: the task may be alive and
   * revised elsewhere. It is read again after a delay that doubles from
   * `RETRY_FIRST_MS` up to `RETRY_MAX_MS`.
   */
  #confirmExpiry(taskId: string, expiry: Expiry, attempt = 0): void {
    const current = () =>
      !this.#closed && this.#expiries.get(taskId) === expiry;
    if (!current()) return;
    if (this.#lookup === undefined) {
      this.#expired(taskId, new TaskNotFoundError(taskId));
      return;
    }
    let unknown = false;
    const retry = () => {
      if (unknown || !current()) return;
      unknown = true;
      const delay = Math.min(RETRY_FIRST_MS * 2 ** attempt, RETRY_MAX_MS);
      this.#later(expiry, delay, () => {
        this.#confirmExpiry(taskId, expiry, attempt + 1);
      });
    };
    let pending: Promise<TaskRecord | undefined>;
    try {
      pending = Promise.resolve(this.#lookup(taskId));
    } catch {
      retry();
      return;
    }
    pending.then((record) => {
      if (!current()) return;
      if (record === undefined || hasExpired(record, this.#now())) {
        this.#expired(taskId, new TaskNotFoundError(taskId));
        return;
      }
      // The record may carry the version already tracked; let it re-arm.
      this.#clearExpiry(taskId);
      this.observe(record);
    }, retry);
  }

  /** Replaces the expiry's one timer. Never keeps the process alive. */
  #later(expiry: Expiry, ms: number, run: () => void): void {
    if (expiry.timer !== undefined) clearTimeout(expiry.timer);
    expiry.timer = setTimeout(run, ms);
    expiry.timer.unref?.();
  }

  /**
   * Rejects a parked waiter first, so it settles exactly once with the
   * expiry error rather than through its abort listener, then aborts the
   * signal for a worker that holds it and releases everything.
   */
  #expired(taskId: string, error: TaskNotFoundError): void {
    const waiter = this.#waiters.get(taskId);
    if (waiter !== undefined) this.#reject(taskId, waiter.token, error);
    this.#signals.get(taskId)?.abort(error);
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

  #controller(taskId: string, arm = true): AbortController {
    let controller = this.#signals.get(taskId);
    if (controller === undefined) {
      controller = new AbortController();
      this.#signals.set(taskId, controller);
      if (arm && !this.#expiries.has(taskId)) this.#arm(taskId, controller);
    }
    return controller;
  }

  /**
   * A worker may read its signal and never write again, so nothing else would
   * tell this process the task's TTL. The first read looks the record up once
   * to arm the expiry. The lookup is a pure read (I3 is unaffected) and only
   * acts if this controller is still the task's signal when it answers.
   */
  #arm(taskId: string, controller: AbortController): void {
    if (this.#lookup === undefined || this.#closed) return;
    let pending: Promise<TaskRecord | undefined>;
    try {
      pending = Promise.resolve(this.#lookup(taskId));
    } catch {
      return; // As for a failed read below.
    }
    pending.then(
      (record) => {
        if (this.#closed || this.#signals.get(taskId) !== controller) return;
        if (record === undefined) {
          this.#expired(taskId, new TaskNotFoundError(taskId));
        } else {
          this.observe(record);
        }
      },
      () => {
        // A failed read arms nothing; the signal is still released by the
        // next committed write, a terminal transition or close().
      },
    );
  }
}

function sameKeys(set: ReadonlySet<string>, keys: readonly string[]): boolean {
  return set.size === keys.length && keys.every((key) => set.has(key));
}
