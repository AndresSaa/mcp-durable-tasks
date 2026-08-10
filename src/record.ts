import type { TaskPatch, TaskRecord } from "./types.js";
import { normalizeJsonObject } from "./json.js";

/**
 * Record rules both included stores share, and that any third-party store has
 * to reproduce.
 *
 * They live here rather than in either store because they are contract, not
 * implementation: a Redis or Postgres `TaskStore` gets them wrong in exactly
 * the same ways, and `mcp-durable-tasks/testing` asserts them against whatever
 * store it is handed.
 */

/**
 * TTL is measured from `createdAt`, not from whenever `ttlMs` last changed.
 * The extension words it as `createdAt` plus `ttlMs`, so raising the TTL
 * extends the same window rather than restarting it, and setting it to `null`
 * makes the task unlimited from that point on — including a task that a
 * previous, shorter TTL would already have doomed.
 */
export function hasExpired(record: TaskRecord, now: number): boolean {
  if (record.ttlMs === null) return false;
  const createdAt = Date.parse(record.createdAt);
  if (Number.isNaN(createdAt)) return false;
  return now >= createdAt + record.ttlMs;
}

/**
 * Applies a patch, where **`undefined` means "remove this field"** rather than
 * "leave it alone" — that is how a task leaving `input_required` drops its
 * requests, and how a completing task stops carrying them.
 *
 * A plain spread cannot express this. `{ ...current, ...patch }` with
 * `inputRequests: undefined` leaves the key present holding `undefined`, and
 * `Object.keys` still reports it, so the wire projection would emit a property
 * the schema's `additionalProperties: false` rejects. Deleting is the only
 * merge that matches the intent.
 *
 * The result is frozen: a consumer that mutated a handed-out record in place
 * would corrupt the store behind the compare-and-swap, which is the class of
 * bug that is impossible to find afterwards.
 */
export function applyPatch(current: TaskRecord, patch: TaskPatch): TaskRecord {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  next.version = current.version + 1;
  return snapshot(next as unknown as TaskRecord);
}

export function snapshot(record: TaskRecord): TaskRecord {
  return Object.freeze(
    normalizeJsonObject(record, "TaskRecord") as unknown as TaskRecord,
  );
}
