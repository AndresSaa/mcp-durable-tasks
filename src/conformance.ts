import type { TaskRecord, TaskStore } from "./types.js";
import { isConcurrentUpdateError } from "./errors.js";

/**
 * The checks a `TaskStore` has to pass, as plain functions.
 *
 * They assert by throwing, and they take no test framework — that is what
 * lets `mcp-durable-tasks/testing` stay dependency-free and work under vitest,
 * node:test, Jest, or no runner at all. `runTaskStoreConformance` wraps them
 * for a runner; `checkTaskStore` runs them directly.
 */

/** What a store implementer hands the kit. */
export interface TaskStoreUnderTest {
  store: TaskStore;
  /**
   * Move this store's clock forward, if it has an injectable one.
   *
   * Optional, and its absence is honest rather than fatal: a store built on a
   * database that reads the wall clock cannot fake time, and making that a
   * failure would push implementers toward faking the check instead. TTL
   * checks are reported as skipped when it is missing — an implementer who
   * wants them covered adds a seam for it.
   */
  advanceTime?: (ms: number) => void | Promise<void>;
  /**
   * Close the current store and return a new instance over the same backing
   * data. Durability checks are skipped when this seam is unavailable.
   */
  reopen?: () => TaskStore | Promise<TaskStore>;
  /** Tear down whatever the factory allocated. `store.close()` is called first. */
  dispose?: () => void | Promise<void>;
}

/**
 * Produces the subject for **one** check.
 *
 * It is invoked once per check, and each call must return a fresh, isolated
 * store — and a fresh clock, if it provides one. Reusing either leaks state
 * between checks: a shared `advanceTime` means the TTL checks inherit
 * whatever time an earlier check moved forward, so a task created with a
 * one-second TTL is already expired before the check begins. That failure
 * looks like a bug in the store and is not one, which is why it is called out
 * here rather than left to be discovered.
 */
export type TaskStoreFactory = () =>
  TaskStore | TaskStoreUnderTest | Promise<TaskStore | TaskStoreUnderTest>;

export interface ConformanceCheck {
  readonly name: string;
  /** Set when the check needs a controllable clock. */
  readonly needsClock?: boolean;
  /** Set when the check needs to reopen the same durable backing store. */
  readonly needsReopen?: boolean;
  run(subject: TaskStoreUnderTest): Promise<void>;
}

/* -- assertions, small enough not to be worth a dependency ---------------- */

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, what: string): void {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalJson(entry)]),
    );
  }
  return value;
}

function assertDeepEqual(
  actual: unknown,
  expected: unknown,
  what: string,
): void {
  assertEqual(
    JSON.stringify(canonicalJson(actual)),
    JSON.stringify(canonicalJson(expected)),
    what,
  );
}

async function reopen(subject: TaskStoreUnderTest): Promise<TaskStore> {
  const previous = subject.store;
  await previous.close();
  const next = await subject.reopen!();
  assert(next !== previous, "reopen() returned the closed store instance");
  subject.store = next;
  return next;
}

/**
 * Matched by `name` rather than `instanceof`. A store published as its own
 * package can easily end up with a second copy of this one in the tree, and
 * failing an implementer for a duplicated class identity would be a false
 * negative about the only thing that matters here: that the CAS contract is
 * observable.
 */
async function assertRejectsConcurrentUpdate(
  operation: Promise<unknown>,
  what: string,
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    assert(
      isConcurrentUpdateError(error),
      `${what}: expected ConcurrentUpdateError, got ${String((error as { name?: string } | undefined)?.name ?? error)}`,
    );
    return;
  }
  throw new Error(`${what}: expected ConcurrentUpdateError, but it resolved`);
}

const BASE_TIME = "2026-01-01T00:00:00.000Z";
let counter = 0;

/** Builds a valid record. Ids are unique per call so checks cannot collide. */
export function conformanceRecord(
  overrides: Partial<TaskRecord> = {},
): TaskRecord {
  counter += 1;
  return {
    taskId: `conformance-${counter}`,
    status: "working",
    createdAt: BASE_TIME,
    lastUpdatedAt: BASE_TIME,
    ttlMs: null,
    version: 0,
    ...overrides,
  } as TaskRecord;
}

/* -- the checks ----------------------------------------------------------- */

export const conformanceChecks: readonly ConformanceCheck[] = [
  {
    name: "create() makes the task retrievable before it resolves (I1)",
    async run({ store }) {
      const record = conformanceRecord();
      await store.create(record);
      const found = await store.get(record.taskId);
      assert(found !== undefined, "get() returned nothing after create()");
      assertEqual(found.taskId, record.taskId, "taskId");
      assertEqual(found.status, "working", "status");
      assertEqual(found.version, 0, "a created record starts at version 0");
    },
  },
  {
    name: "create() refuses to overwrite an existing task",
    async run({ store }) {
      const record = conformanceRecord();
      await store.create(record);
      let threw = false;
      try {
        await store.create({ ...record, statusMessage: "overwritten" });
      } catch {
        threw = true;
      }
      assert(threw, "create() silently overwrote an existing task");
      assertDeepEqual(
        await store.get(record.taskId),
        record,
        "record after a duplicate create()",
      );
    },
  },
  {
    name: "get() returns undefined for an unknown id, rather than throwing",
    async run({ store }) {
      const found = await store.get("definitely-not-a-task");
      assertEqual(found, undefined, "get() of an unknown id");
    },
  },
  {
    name: "get() does not mutate the record (I3)",
    async run({ store }) {
      const record = conformanceRecord();
      await store.create(record);
      const first = await store.get(record.taskId);
      const second = await store.get(record.taskId);
      assertDeepEqual(second, first, "record after two reads");
    },
  },
  {
    name: "update() applies the patch and bumps the version by exactly one",
    async run({ store }) {
      const record = conformanceRecord();
      await store.create(record);
      const written = await store.update(
        record.taskId,
        { statusMessage: "moved" },
        0,
      );
      assertEqual(written.version, 1, "version after one update");
      assertEqual(written.statusMessage, "moved", "patched field");
      const reread = await store.get(record.taskId);
      assertEqual(reread?.statusMessage, "moved", "patched field, re-read");
      assertEqual(reread?.version, 1, "version, re-read");
    },
  },
  {
    name: "update() persists input requests, partial responses and used keys",
    async run({ store }) {
      const record = conformanceRecord();
      await store.create(record);
      const inputRequests = {
        alpha: { method: "roots/list" as const },
        beta: { method: "roots/list" as const },
      };
      const inputResponses = { alpha: { roots: [] } };
      const written = await store.update(
        record.taskId,
        {
          status: "input_required",
          inputRequests,
          inputResponses,
          usedInputKeys: ["alpha", "beta"],
        },
        0,
      );
      const reread = await store.get(record.taskId);
      assertDeepEqual(reread, written, "input state after re-read");
      assertDeepEqual(
        reread?.inputRequests,
        inputRequests,
        "input requests after re-read",
      );
      assertDeepEqual(
        reread?.inputResponses,
        inputResponses,
        "partial responses after re-read",
      );
      assertDeepEqual(
        reread?.usedInputKeys,
        ["alpha", "beta"],
        "used keys after re-read",
      );
    },
  },
  {
    name: "update() rejects a stale version and changes nothing",
    async run({ store }) {
      const record = conformanceRecord();
      await store.create(record);
      await store.update(record.taskId, { statusMessage: "first" }, 0);

      await assertRejectsConcurrentUpdate(
        store.update(record.taskId, { statusMessage: "stale" }, 0),
        "update() with a stale version",
      );

      const reread = await store.get(record.taskId);
      assertEqual(reread?.statusMessage, "first", "record after a lost race");
      assertEqual(reread?.version, 1, "version after a lost race");
    },
  },
  {
    name: "update() of a missing task reports a lost race, not a new task",
    async run({ store }) {
      await assertRejectsConcurrentUpdate(
        store.update("definitely-not-a-task", { statusMessage: "x" }, 0),
        "update() of an unknown id",
      );
      const found = await store.get("definitely-not-a-task");
      assertEqual(found, undefined, "update() must not create a task");
    },
  },
  {
    name: "an undefined patch value deletes the field, it does not skip it",
    async run({ store }) {
      // The rule every third-party store gets wrong first. The engine relies
      // on it: a task leaving input_required clears its requests this way, and
      // a leftover map would be emitted onto a wire shape that forbids it.
      const record = conformanceRecord({
        status: "input_required",
        inputRequests: { key: { method: "roots/list" } },
      });
      await store.create(record);
      const written = await store.update(
        record.taskId,
        { status: "working", inputRequests: undefined },
        0,
      );
      assert(
        !("inputRequests" in written),
        "inputRequests survived a patch that set it to undefined",
      );
      const reread = await store.get(record.taskId);
      assert(
        reread !== undefined && !("inputRequests" in reread),
        "inputRequests came back after a re-read",
      );
    },
  },
  {
    name: "patches use enumerable own string-keyed properties",
    async run({ store }) {
      const record = conformanceRecord();
      await store.create(record);
      const prototype = { statusMessage: "inherited" };
      const patch = Object.create(prototype) as {
        pollIntervalMs?: number;
        ttlMs?: number;
      };
      patch.pollIntervalMs = 250;
      Object.defineProperty(patch, "ttlMs", {
        value: 5_000,
        enumerable: false,
      });

      const written = await store.update(record.taskId, patch, 0);
      assertEqual(written.pollIntervalMs, 250, "enumerable own property");
      assertEqual(
        written.statusMessage,
        undefined,
        "inherited property must not be applied",
      );
      assertEqual(
        written.ttlMs,
        null,
        "non-enumerable property must not be applied",
      );
    },
  },
  {
    name: "records handed out are copies, not live references",
    async run({ store }) {
      const createPayload = { answer: 1 };
      const record = conformanceRecord({
        status: "completed",
        result: createPayload,
      });
      await store.create(record);

      createPayload.answer = 2;
      const afterCreateInput = await store.get(record.taskId);
      assertEqual(
        (afterCreateInput?.result as { answer?: number } | undefined)?.answer,
        1,
        "stored result after mutating the object passed to create()",
      );

      const payload = { answer: 3 };
      await store.update(
        record.taskId,
        { status: "completed", result: payload },
        0,
      );

      // Mutating what was passed in must not reach stored state.
      payload.answer = 4;
      const afterInput = await store.get(record.taskId);
      assertEqual(
        (afterInput?.result as { answer?: number } | undefined)?.answer,
        3,
        "stored result after mutating the caller's object",
      );

      // Nor must mutating what was handed back.
      const view = afterInput?.result as Record<string, unknown> | undefined;
      try {
        if (view !== undefined) view.answer = 5;
      } catch {
        // A frozen record throws instead; either is fine.
      }
      const afterOutput = await store.get(record.taskId);
      assertEqual(
        (afterOutput?.result as { answer?: number } | undefined)?.answer,
        3,
        "stored result after mutating the returned object",
      );
    },
  },
  {
    name: "JSON numbers are canonical before storage and replay",
    async run({ store }) {
      const record = conformanceRecord({
        status: "completed",
        result: { nested: { signedZero: -0 } },
      });
      await store.create(record);
      const created = await store.get(record.taskId);
      const createdZero = (
        created?.result as { nested?: { signedZero?: number } } | undefined
      )?.nested?.signedZero;
      assert(
        Object.is(createdZero, 0),
        "create() retained -0 instead of canonicalising it to 0",
      );

      const written = await store.update(
        record.taskId,
        { result: { nested: { signedZero: -0 } } },
        0,
      );
      const writtenZero = (written.result as { nested: { signedZero: number } })
        .nested.signedZero;
      assert(
        Object.is(writtenZero, 0),
        "update() retained -0 instead of canonicalising it to 0",
      );
    },
  },
  {
    name: "create() survives a close and reopen cycle (I1)",
    needsReopen: true,
    async run(subject) {
      const record = conformanceRecord({
        statusMessage: "durable",
        usedInputKeys: ["past-key"],
      });
      await subject.store.create(record);
      const store = await reopen(subject);
      assertDeepEqual(
        await store.get(record.taskId),
        record,
        "record after reopen",
      );
    },
  },
  {
    name: "an input round survives reopen and retains its used-key ledger (I1, I5)",
    needsReopen: true,
    async run(subject) {
      const record = conformanceRecord({ usedInputKeys: ["older"] });
      await subject.store.create(record);
      const partial = await subject.store.update(
        record.taskId,
        {
          status: "input_required",
          inputRequests: {
            alpha: { method: "roots/list" },
            beta: { method: "roots/list" },
          },
          inputResponses: { alpha: { roots: [] } },
          usedInputKeys: ["older", "alpha", "beta"],
        },
        0,
      );

      let store = await reopen(subject);
      assertDeepEqual(
        await store.get(record.taskId),
        partial,
        "partial input state after reopen",
      );

      const resumed = await store.update(
        record.taskId,
        {
          status: "working",
          inputRequests: undefined,
          inputResponses: undefined,
        },
        partial.version,
      );
      store = await reopen(subject);
      const recovered = await store.get(record.taskId);
      assertDeepEqual(recovered, resumed, "completed input round after reopen");
      assertDeepEqual(
        recovered?.usedInputKeys,
        ["older", "alpha", "beta"],
        "used-key ledger after the input round",
      );
      assert(
        recovered !== undefined &&
          !("inputRequests" in recovered) &&
          !("inputResponses" in recovered),
        "completed input round retained live request or response maps",
      );
    },
  },
  {
    name: "sweep() returns a count and never a payload (I7)",
    async run({ store }) {
      const swept = await store.sweep();
      assertEqual(
        typeof swept,
        "number",
        "sweep() must return a number, never the records it dropped",
      );
      assert(swept >= 0, "sweep() returned a negative count");
    },
  },
  {
    name: "a task with ttlMs: null never expires",
    needsClock: true,
    async run({ store, advanceTime }) {
      const record = conformanceRecord({ ttlMs: null });
      await store.create(record);
      await advanceTime!(10_000_000);
      const found = await store.get(record.taskId);
      assert(found !== undefined, "an unlimited task expired");
    },
  },
  {
    name: "get() hides an expired task before any sweep runs",
    needsClock: true,
    async run({ store, advanceTime }) {
      const record = conformanceRecord({ ttlMs: 1_000 });
      await store.create(record);
      assert(
        (await store.get(record.taskId)) !== undefined,
        "task vanished before its TTL elapsed",
      );

      await advanceTime!(1_000);
      assertEqual(
        await store.get(record.taskId),
        undefined,
        "expired task is still readable",
      );
    },
  },
  {
    name: "expiry is measured from createdAt, not from when ttlMs changed",
    needsClock: true,
    async run({ store, advanceTime }) {
      const record = conformanceRecord({ ttlMs: 1_000 });
      await store.create(record);

      await advanceTime!(500);
      await store.update(record.taskId, { ttlMs: 2_000 }, 0);

      await advanceTime!(1_000); // 1500ms in: inside the extended window
      assert(
        (await store.get(record.taskId)) !== undefined,
        "task expired inside its extended window",
      );

      await advanceTime!(500); // 2000ms from createdAt: the window closes
      assertEqual(
        await store.get(record.taskId),
        undefined,
        "extended window was measured from the change instead of createdAt",
      );
    },
  },
  {
    name: "sweep() counts what it removed",
    needsClock: true,
    async run({ store, advanceTime }) {
      const expiring = conformanceRecord({ ttlMs: 1_000 });
      const permanent = conformanceRecord({ ttlMs: null });
      await store.create(expiring);
      await store.create(permanent);

      await advanceTime!(1_000);
      const swept = await store.sweep();
      assertEqual(swept, 1, "number of expired tasks removed by sweep()");
      assert(
        (await store.get(permanent.taskId)) !== undefined,
        "sweep() removed a task that had not expired",
      );
      await store.create({ ...expiring, ttlMs: null });
      assert(
        (await store.get(expiring.taskId)) !== undefined,
        "sweep() hid the expired task but did not physically remove it",
      );
    },
  },
  {
    name: "close() is idempotent",
    async run({ store }) {
      await store.close();
      await store.close();
    },
  },
];
