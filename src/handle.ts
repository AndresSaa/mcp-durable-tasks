import { isInputRequest } from "./input.js";
import { normalizeJsonObject, normalizeJsonValue } from "./json.js";
import type {
  InputRequest,
  InputResponses,
  JsonObject,
  TaskHandle,
  TaskPatch,
  TaskRecord,
} from "./types.js";
import { assertTtlMs } from "./validation.js";

/**
 * The write side of a task, as a worker sees it.
 *
 * Everything here funnels through `mutate`, which the lifecycle owns: it holds
 * the compare-and-swap loop, the terminality check and the clock. Splitting the
 * handle out of the lifecycle is worth it anyway — a worker holds this object
 * for as long as its work runs, and it should not be able to reach `getTask`,
 * `close`, or another task's state through it.
 */

/** What the handle needs from the lifecycle. Internal, never exported. */
export interface TaskWriter {
  mutate(
    taskId: string,
    change: (record: TaskRecord) => TaskPatch | undefined,
  ): Promise<TaskRecord>;
  signalFor(taskId: string): AbortSignal;
  requestInput(
    taskId: string,
    requests: Record<string, InputRequest>,
  ): Promise<InputResponses>;
}

export function createTaskHandle(
  taskId: string,
  writer: TaskWriter,
): TaskHandle {
  return {
    taskId,

    get signal() {
      return writer.signalFor(taskId);
    },

    async progress(statusMessage, patch) {
      if (patch?.ttlMs !== undefined) {
        assertTtlMs(patch.ttlMs, "progress() ttlMs");
      }
      await writer.mutate(taskId, () => ({
        statusMessage,
        ...(patch?.pollIntervalMs !== undefined && {
          pollIntervalMs: patch.pollIntervalMs,
        }),
        // `ttlMs: null` is a meaningful value (unlimited), so this tests for
        // presence of the key rather than truthiness.
        ...(patch?.ttlMs !== undefined && { ttlMs: patch.ttlMs }),
      }));
    },

    async requestInput(requests: Record<string, InputRequest>) {
      const keys = Object.keys(requests);
      if (keys.length === 0) {
        throw new TypeError("requestInput() needs at least one input request");
      }

      for (const key of keys) {
        if (!isInputRequest(requests[key])) {
          throw new TypeError(
            `Input request ${JSON.stringify(key)} is not one of MCP's server-to-client requests ` +
              `(sampling/createMessage, roots/list, elicitation/create)`,
          );
        }
      }

      return writer.requestInput(
        taskId,
        normalizeJsonValue(
          requests,
          "requestInput() requests",
        ) as unknown as Record<string, InputRequest>,
      );
    },

    async complete(result: JsonObject) {
      const normalized = normalizeJsonObject(result, "complete");
      await writer.mutate(taskId, () => ({
        status: "completed",
        result: normalized,
        // A completed task holds no outstanding requests. usedInputKeys stays:
        // the no-reuse rule outlives the terminal transition (I5).
        inputRequests: undefined,
        inputResponses: undefined,
      }));
    },

    async fail(error: JsonObject) {
      const normalized = normalizeJsonObject(error, "fail");
      await writer.mutate(taskId, () => ({
        status: "failed",
        error: normalized,
        inputRequests: undefined,
        inputResponses: undefined,
      }));
    },

    async cancelled(statusMessage?: string) {
      await writer.mutate(taskId, () => ({
        status: "cancelled",
        ...(statusMessage !== undefined && { statusMessage }),
        inputRequests: undefined,
        inputResponses: undefined,
      }));
    },
  };
}
