/**
 * The server-side engine of the MCP Tasks extension
 * (`io.modelcontextprotocol/tasks`, SEP-2663).
 *
 * This is a library you import, not a server you add to an `mcp.json`, and the
 * "tasks" in the name are the extension's durable task handles — not a to-do
 * list.
 *
 * Zero runtime dependencies, and no Node built-ins on this entry point: the
 * engine and `MemoryTaskStore` run wherever the web platform does.
 * `mcp-durable-tasks/wal` is the entry point that may need `node:fs`.
 */

export { TaskLifecycle } from "./lifecycle.js";
export { MemoryTaskStore } from "./memory-store.js";

export {
  ConcurrentUpdateError,
  TaskCancelled,
  DuplicateInputKeyError,
  isConcurrentUpdateError,
  isTaskEntryTooLargeError,
  TaskAlreadyTerminalError,
  TaskEntryTooLargeError,
  TaskNotFoundError,
} from "./errors.js";

export type {
  CancelTaskResult,
  CancelledTask,
  CompletedTask,
  CreateTaskResult,
  DetailedTask,
  FailedTask,
  GetTaskResult,
  InputRequest,
  InputRequests,
  InputResponse,
  InputResponses,
  InputRequiredTask,
  JsonObject,
  JsonValue,
  TaskHandle,
  TaskLifecycleOptions,
  TaskPatch,
  TaskRecord,
  TaskStatus,
  TaskStore,
  TerminalTaskStatus,
  UpdateTaskResult,
  WorkingTask,
} from "./types.js";
