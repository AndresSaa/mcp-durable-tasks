import type {
  CreateTaskResult,
  DetailedTask,
  TaskRecord,
  TaskStatus,
} from "./types.js";

/**
 * The boundary between what a store keeps and what goes over the wire.
 *
 * Every task variant in the extension's schema sets
 * `additionalProperties: false`. A record carries three fields no conforming
 * response may contain — `version`, `inputResponses` and `usedInputKeys` —
 * so the projection is **allow-list based, never a spread**. Copying the
 * record and deleting the internal fields would leak the next one somebody
 * adds; this way a new internal field is invisible until someone deliberately
 * lists it.
 */

const TERMINAL: ReadonlySet<TaskStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL.has(status);
}

/** The five base fields plus the two optional hints, and nothing else. */
function base(record: TaskRecord) {
  return {
    taskId: record.taskId,
    createdAt: record.createdAt,
    lastUpdatedAt: record.lastUpdatedAt,
    ttlMs: record.ttlMs,
    // Both are optional in the schema, so an absent value is omitted rather
    // than sent as undefined — JSON.stringify would drop it anyway, but an
    // explicit key makes deep-equality assertions lie.
    ...(record.statusMessage !== undefined && {
      statusMessage: record.statusMessage,
    }),
    ...(record.pollIntervalMs !== undefined && {
      pollIntervalMs: record.pollIntervalMs,
    }),
  };
}

const COMPLETE_RESULT = { resultType: "complete" } as const;

function corrupt(record: TaskRecord, detail: string): never {
  throw new Error(`Stored task ${record.taskId} is inconsistent: ${detail}`);
}

function assertNoPayloads(
  record: TaskRecord,
  fields: readonly ("inputRequests" | "inputResponses" | "result" | "error")[],
): void {
  for (const field of fields) {
    if (record[field] !== undefined) {
      corrupt(record, `${field} is not valid for status ${record.status}`);
    }
  }
}

function assertRecordShape(record: TaskRecord): void {
  switch (record.status) {
    case "working":
    case "cancelled":
      assertNoPayloads(record, [
        "inputRequests",
        "inputResponses",
        "result",
        "error",
      ]);
      return;
    case "input_required":
      if (record.inputRequests === undefined) {
        corrupt(record, "input_required has no inputRequests");
      }
      assertNoPayloads(record, ["result", "error"]);
      return;
    case "completed":
      if (record.result === undefined) {
        corrupt(record, "completed has no result");
      }
      assertNoPayloads(record, ["inputRequests", "inputResponses", "error"]);
      return;
    case "failed":
      if (record.error === undefined) {
        corrupt(record, "failed has no error");
      }
      assertNoPayloads(record, ["inputRequests", "inputResponses", "result"]);
  }
}

/** `tasks/get` — the status-specific variant. */
export function toDetailedTask(record: TaskRecord): DetailedTask {
  assertRecordShape(record);
  switch (record.status) {
    case "working":
      return { ...base(record), ...COMPLETE_RESULT, status: "working" };

    case "input_required":
      return {
        ...base(record),
        ...COMPLETE_RESULT,
        status: "input_required",
        inputRequests: structuredClone(record.inputRequests!),
      };

    case "completed":
      return {
        ...base(record),
        ...COMPLETE_RESULT,
        status: "completed",
        result: structuredClone(record.result!),
      };

    case "failed":
      return {
        ...base(record),
        ...COMPLETE_RESULT,
        status: "failed",
        error: structuredClone(record.error!),
      };

    case "cancelled":
      return { ...base(record), ...COMPLETE_RESULT, status: "cancelled" };
  }
}

/**
 * `CreateTaskResult` is `Result & Task` — the *base* task, flat, without the
 * status-specific fields. A freshly created task is `working` and has none of
 * them anyway, but the type says so explicitly so a future caller cannot
 * accidentally return `inputRequests` here.
 */
export function toCreateTaskResult(record: TaskRecord): CreateTaskResult {
  assertRecordShape(record);
  return { ...base(record), resultType: "task", status: record.status };
}
