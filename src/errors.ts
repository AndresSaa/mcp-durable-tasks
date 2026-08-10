/**
 * Errors the library throws. The classes remain useful for construction and
 * local inspection, but consumers must use the exported stable predicates at
 * package boundaries: npm can legitimately install two copies whose class
 * identities differ, and the CJS entry bundles also carry separate copies.
 *
 * There is deliberately no error for an unrecognised input key. The extension
 * says a server SHOULD *ignore* responses whose key is not currently
 * outstanding — including keys never issued, keys already answered, and keys
 * whose request was superseded. Throwing there would be a conformance bug, so
 * `updateTask` counts them and carries on. See `docs/contract.md#input-rounds`.
 */

/**
 * Recognises a library error by a stable property rather than by class
 * identity.
 *
 * `instanceof` cannot be the contract across a package boundary: a duplicated
 * copy in the dependency tree, or the separate CJS bundle each entry point
 * gets, produces a different class object for the same error. The predicates
 * below all reduce to this one check.
 */
function hasErrorProperty(
  error: unknown,
  key: "name" | "code",
  value: string,
): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as Record<string, unknown>)[key] === value
  );
}

/** No task with that ID, or its TTL elapsed. Answer the client `-32602`. */
export class TaskNotFoundError extends Error {
  readonly taskId: string;

  constructor(taskId: string) {
    super(`No task with id ${taskId}`);
    this.name = "TaskNotFoundError";
    this.taskId = taskId;
  }
}

/**
 * A transition out of `completed`, `failed` or `cancelled` was attempted (I2).
 *
 * This is the library's own bug class, not the caller's: it means a worker
 * kept writing after it finished, or two code paths both owned the same task.
 * It throws rather than being swallowed precisely because a silently ignored
 * double-complete is the defect this package claims to prevent.
 */
export class TaskAlreadyTerminalError extends Error {
  readonly taskId: string;
  readonly status: string;

  constructor(taskId: string, status: string) {
    super(`Task ${taskId} is already ${status} and cannot change again`);
    this.name = "TaskAlreadyTerminalError";
    this.taskId = taskId;
    this.status = status;
  }
}

/**
 * Compare-and-swap lost: the stored version moved between read and write.
 * The caller retries — the engine already does, with a bounded number of
 * attempts.
 */
export class ConcurrentUpdateError extends Error {
  readonly taskId: string;
  readonly expectedVersion: number;
  readonly actualVersion: number | undefined;

  constructor(
    taskId: string,
    expectedVersion: number,
    actualVersion: number | undefined,
  ) {
    super(
      `Task ${taskId} changed underneath: expected version ${expectedVersion}, found ${actualVersion ?? "none"}`,
    );
    this.name = "ConcurrentUpdateError";
    this.taskId = taskId;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

/**
 * Recognises a lost-CAS error across duplicated package installations.
 *
 * Requiring `instanceof` here would make a correct third-party store fail when
 * it constructs the same public error class from another physical copy of the
 * package. The engine and conformance kit deliberately share this predicate.
 */
export function isConcurrentUpdateError(
  error: unknown,
): error is Error & { readonly name: "ConcurrentUpdateError" } {
  return hasErrorProperty(error, "name", "ConcurrentUpdateError");
}

/**
 * An input key was reused within one task's lifetime (I5). Normative: a server
 * MUST NOT reuse a key after a response for it has been delivered, and that
 * obligation does not end when the task reaches a terminal state.
 */
export class DuplicateInputKeyError extends Error {
  readonly taskId: string;
  readonly key: string;

  constructor(taskId: string, key: string) {
    super(
      `Input key ${JSON.stringify(key)} was already used by task ${taskId}; keys are unique for the task's whole lifetime`,
    );
    this.name = "DuplicateInputKeyError";
    this.taskId = taskId;
    this.key = key;
  }
}

/**
 * A durable store rejected a task record because its encoded entry is larger
 * than the configured write limit.
 *
 * The mutation did not commit, so a worker may catch this error and retry the
 * same terminal transition with a truncated result. `code` intentionally
 * preserves process-wal's stable public code for duplicated-package and
 * non-`instanceof` consumers.
 */
export class TaskEntryTooLargeError extends Error {
  readonly code = "ERR_ENTRY_TOO_LARGE" as const;
  readonly taskId: string | undefined;
  readonly maxEntryBytes: number;

  constructor(
    maxEntryBytes: number,
    taskId: string | undefined,
    cause: unknown,
  ) {
    super(
      `${taskId === undefined ? "Task record" : `Task ${taskId}`} exceeds WalTaskStore maxEntryBytes (${maxEntryBytes} bytes)`,
      { cause },
    );
    this.name = "TaskEntryTooLargeError";
    this.taskId = taskId;
    this.maxEntryBytes = maxEntryBytes;
  }
}

/**
 * Recognises an oversized WAL entry across duplicated packages and bundles.
 * The code originates in process-wal and is deliberately preserved by
 * `TaskEntryTooLargeError`; class identity is not part of that contract.
 */
export function isTaskEntryTooLargeError(
  error: unknown,
): error is Error & { readonly code: "ERR_ENTRY_TOO_LARGE" } {
  return hasErrorProperty(error, "code", "ERR_ENTRY_TOO_LARGE");
}

/** The reason an aborted signal carries, so a worker can tell why it woke. */
export class TaskCancelled extends Error {
  readonly taskId: string;

  constructor(taskId: string) {
    super(`Task ${taskId} received tasks/cancel`);
    this.name = "TaskCancelled";
    this.taskId = taskId;
  }
}
