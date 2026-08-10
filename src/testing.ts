import {
  conformanceChecks,
  type ConformanceCheck,
  type TaskStoreFactory,
  type TaskStoreUnderTest,
} from "./conformance.js";
import type { TaskStore } from "./types.js";

/**
 * The store conformance kit.
 *
 * If you are publishing a `TaskStore` over Redis, Postgres, SQLite or D1, this
 * is the suite that tells you it is correct — and you have it before you write
 * the first line. That is deliberate: the interface being trivial to implement
 * is only useful if "implemented correctly" is something you can check.
 *
 * It carries no dependencies and no test framework. `runTaskStoreConformance`
 * uses whatever runner you already have (vitest, node:test, Jest — anything
 * that puts `describe`/`it` on the global object), and `checkTaskStore` runs
 * the same checks with no runner at all, which is what you want in a script or
 * a CI step that just needs a verdict.
 */

export type {
  ConformanceCheck,
  TaskStoreFactory,
  TaskStoreUnderTest,
} from "./conformance.js";
export { conformanceChecks, conformanceRecord } from "./conformance.js";

const DEFAULT_TIMEOUT_MS = 10_000;

export interface CheckOutcome {
  readonly name: string;
  readonly status: "passed" | "failed" | "skipped";
  /** Present when `status === 'failed'`. */
  readonly error?: unknown;
  /** Present when `status === 'skipped'`, saying what was missing. */
  readonly reason?: string;
}

export interface CheckReport {
  readonly store: string;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly outcomes: readonly CheckOutcome[];
  /** True when nothing failed. Skipped checks do not make a report false. */
  readonly ok: boolean;
}

function normalise(
  subject: TaskStore | TaskStoreUnderTest,
): TaskStoreUnderTest {
  return "store" in subject ? subject : { store: subject };
}

function timeoutMs(value: number | undefined): number {
  const resolved = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new TypeError("timeoutMs must be a positive finite number");
  }
  return resolved;
}

async function withinDeadline<T>(
  operation: () => T | PromiseLike<T>,
  limitMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${limitMs}ms`)),
      limitMs,
    );
    (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([Promise.resolve().then(operation), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function throwCollected(errors: unknown[]): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "the check and its cleanup both failed");
  }
}

async function withSubject<T>(
  factory: TaskStoreFactory,
  body: (subject: TaskStoreUnderTest) => Promise<T>,
  seen: WeakSet<TaskStore>,
  limitMs: number,
): Promise<T> {
  const subject = normalise(
    await withinDeadline(factory, limitMs, "TaskStore factory"),
  );
  const reused = seen.has(subject.store);
  seen.add(subject.store);
  const errors: unknown[] = [];
  let value: T | undefined;
  try {
    if (reused) {
      throw new Error(
        "TaskStore factory reused a store instance; every check needs a fresh, isolated store",
      );
    }
    value = await withinDeadline(
      () => body(subject),
      limitMs,
      "conformance check",
    );
  } catch (error) {
    errors.push(error);
  } finally {
    // close() before dispose(): a store that flushes on close must be allowed
    // to, and a dispose() that removed its directory first would make that
    // flush fail for reasons the implementer did not cause.
    try {
      await withinDeadline(
        () => subject.store.close(),
        limitMs,
        "TaskStore.close()",
      );
    } catch (error) {
      errors.push(error);
    }
    if (subject.dispose !== undefined) {
      try {
        await withinDeadline(subject.dispose, limitMs, "factory dispose()");
      } catch (error) {
        errors.push(error);
      }
    }
  }
  throwCollected(errors);
  return value as T;
}

const NO_CLOCK =
  "the factory did not provide advanceTime(), so time-dependent behaviour was not exercised";
const NO_REOPEN =
  "the factory did not provide reopen(), so persistence across store instances was not exercised";

function missingCapability(
  check: ConformanceCheck,
  subject: TaskStoreUnderTest,
): string | undefined {
  if (check.needsClock === true && subject.advanceTime === undefined) {
    return NO_CLOCK;
  }
  if (check.needsReopen === true && subject.reopen === undefined) {
    return NO_REOPEN;
  }
  return undefined;
}

export interface CheckTaskStoreOptions {
  /** Per-operation deadline. Defaults to 10 seconds. */
  timeoutMs?: number;
}

/**
 * Runs every check against a fresh store and returns what happened, without
 * needing a test framework.
 *
 * Each check gets its **own** store instance. Sharing one would let a check
 * that leaves a task behind change what the next one sees, and a conformance
 * suite whose results depend on ordering is worse than none.
 */
export async function checkTaskStore(
  name: string,
  factory: TaskStoreFactory,
  checks: readonly ConformanceCheck[] = conformanceChecks,
  options: CheckTaskStoreOptions = {},
): Promise<CheckReport> {
  const outcomes: CheckOutcome[] = [];
  const seen = new WeakSet<TaskStore>();
  const limitMs = timeoutMs(options.timeoutMs);

  for (const check of checks) {
    try {
      const outcome = await withSubject(
        factory,
        async (subject) => {
          const reason = missingCapability(check, subject);
          if (reason !== undefined) {
            return { name: check.name, status: "skipped", reason } as const;
          }
          await check.run(subject);
          return { name: check.name, status: "passed" } as const;
        },
        seen,
        limitMs,
      );
      outcomes.push(outcome);
    } catch (error) {
      outcomes.push({ name: check.name, status: "failed", error });
    }
  }

  const passed = outcomes.filter((o) => o.status === "passed").length;
  const failed = outcomes.filter((o) => o.status === "failed").length;
  const skipped = outcomes.filter((o) => o.status === "skipped").length;

  return { store: name, passed, failed, skipped, outcomes, ok: failed === 0 };
}

/** The two primitives the kit needs from a test runner. */
export interface ConformanceRunner {
  describe: (name: string, body: () => void) => unknown;
  it: (
    name: string,
    body: (context: unknown) => Promise<void> | void,
  ) => unknown;
  /** Mark the currently running test as skipped using the runner's context. */
  skip?: (context: unknown, reason: string) => void | Promise<void>;
}

export interface RunConformanceOptions {
  /** Override the check list, e.g. to run a subset while debugging. */
  checks?: readonly ConformanceCheck[];
  /**
   * Pass your runner's `describe`/`it` explicitly.
   *
   * Falls back to the globals when omitted, which is what Jest and a
   * `globals: true` vitest give you. Passing them is preferred: requiring
   * globals would force a config change on every consumer just to run this
   * suite, and vitest's own default is explicit imports.
   */
  runner?: ConformanceRunner;
  /** Per-operation deadline. Defaults to 10 seconds. */
  timeoutMs?: number;
}

/**
 * Declares the conformance suite in whatever test runner you are using.
 *
 * ```ts
 * import { describe, it } from "vitest";
 * import { runTaskStoreConformance } from "mcp-durable-tasks/testing";
 *
 * runTaskStoreConformance(
 *   "RedisTaskStore",
 *   () => ({
 *     store: new RedisTaskStore({ url }),
 *     advanceTime: (ms) => redisClock.advance(ms),
 *     reopen: () => new RedisTaskStore({ url }),
 *     dispose: () => redisClock.reset(),
 *   }),
 *   {
 *     runner: {
 *       describe,
 *       it,
 *       skip: (context, reason) =>
 *         (context as { skip(reason?: string): void }).skip(reason),
 *     },
 *   },
 * );
 * ```
 *
 * The factory may return the store directly when it has no clock or reopen
 * seam and nothing to tear down. Checks needing either seam are genuinely
 * skipped through `runner.skip`; without that adapter, they fail explicitly
 * rather than passing on no evidence.
 */
export function runTaskStoreConformance(
  name: string,
  factory: TaskStoreFactory,
  options: RunConformanceOptions = {},
): void {
  const checks = options.checks ?? conformanceChecks;
  const limitMs = timeoutMs(options.timeoutMs);
  const seen = new WeakSet<TaskStore>();
  const runner =
    options.runner ??
    (globalThis as unknown as Partial<ConformanceRunner> | undefined);

  if (
    runner === undefined ||
    typeof runner.describe !== "function" ||
    typeof runner.it !== "function"
  ) {
    throw new Error(
      "runTaskStoreConformance() needs a test runner. Pass one explicitly as " +
        "{ runner: { describe, it } }, or use checkTaskStore() to run the same " +
        "checks without a runner — it returns a report instead of declaring tests.",
    );
  }

  const { describe, it, skip } = runner as ConformanceRunner;

  describe(`TaskStore conformance: ${name}`, () => {
    for (const check of checks) {
      void it(check.name, async (context) => {
        await withSubject(
          factory,
          async (subject) => {
            const reason = missingCapability(check, subject);
            if (reason !== undefined) {
              if (skip === undefined) {
                throw new Error(
                  `${check.name} cannot run: ${reason}. ` +
                    "Provide runner.skip(context, reason) so the runner records a real skip.",
                );
              }
              await skip(context, reason);
              return;
            }
            await check.run(subject);
          },
          seen,
          limitMs,
        );
      });
    }
  });
}
