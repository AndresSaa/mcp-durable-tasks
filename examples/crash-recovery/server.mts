/**
 * A real MCP server whose tasks outlive the process.
 *
 * `tools/call` defers to a task; the task's state lives in a `WalTaskStore` on
 * disk. Kill this process at any moment and start it again: the store replays
 * and `tasks/get` answers from where the dead process left off.
 *
 * ## Serving `tasks/*` through the SDK
 *
 * The three task methods are ordinary request handlers registered with an
 * **explicit params schema** — `setRequestHandler(method, schemas, handler)`.
 * That form is what `@modelcontextprotocol/server` 2.3.0 and later serve on a
 * 2026-07-28 connection. `tasks/get` and `tasks/cancel` are names the retired
 * 2025-11-25 registry also used, and the SDK's protocol-era gate still answers
 * `-32601` for them when they are registered the typed way, `(method,
 * handler)`, or left to `fallbackRequestHandler`. Earlier server versions
 * gated them whatever the registration; this example therefore requires
 * `^2.3.0` and needs no HTTP middleware or transport rewrite. See the SDK
 * compatibility profile in `docs/contract.md`.
 *
 * The SDK also validates the `Mcp-Name` routing header against
 * `params.taskId` before any of this runs, so a load balancer can route on it.
 */
import { createServer } from "node:http";
import {
  createMcpHandler,
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  type StandardSchemaV1,
} from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { TaskLifecycle, TaskNotFoundError } from "mcp-durable-tasks";
import type { InputResponses } from "mcp-durable-tasks";
import { WalTaskStore } from "mcp-durable-tasks/wal";

const dir = process.argv[2];
const port = Number(process.argv[3] ?? 0);
if (dir === undefined) throw new Error("usage: server.mts <dir> [port]");

/**
 * One store, one process, one directory — the supported shape. The engine and
 * the store are created once and shared by every request; the tasks they hold
 * are what survives this process being killed.
 */
const store = new WalTaskStore({ dir });
const tasks = new TaskLifecycle({ store, defaultPollIntervalMs: 250 });

/** The extension's capability key, declared by both peers. */
const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";

/** Pretends to be a long build. Writes progress through the durable handle. */
async function indexCorpus(taskId: string): Promise<void> {
  const task = tasks.handle(taskId);
  for (let file = 1; file <= 5; file += 1) {
    if (task.signal.aborted) return task.cancelled("client cancelled");
    await task.progress(`indexed ${file}/5 files`);
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  await task.complete({
    content: [{ type: "text", text: "indexed 5 files, 0 errors" }],
    indexedAt: new Date().toISOString(),
  });
}

/* -- Params schema ------------------------------------------------------- */

/**
 * A minimal Standard Schema for `{ taskId }`, so the example needs no
 * validation library. Any Standard Schema implementation (zod, valibot,
 * arktype) works here; what the SDK requires is that *some* schema is passed,
 * because that is what exempts `tasks/get` and `tasks/cancel` from the era
 * gate. The engine validates input-response payloads itself.
 */
const taskParams: StandardSchemaV1<unknown, { taskId: string }> = {
  "~standard": {
    version: 1,
    vendor: "mcp-durable-tasks-example",
    validate: (value) => {
      const taskId =
        typeof value === "object" && value !== null
          ? (value as { taskId?: unknown }).taskId
          : undefined;
      return typeof taskId === "string"
        ? { value: { taskId } }
        : { issues: [{ message: "taskId must be a string" }] };
    },
  },
};

/**
 * TaskNotFoundError covers "no such task" and "its TTL elapsed"; the extension
 * does not distinguish them, and neither should a server.
 *
 * The spread turns the engine's named result interface into the plain record
 * the SDK's handler type expects; the value is unchanged.
 */
async function answer(
  taskId: string,
  run: () => Promise<object>,
): Promise<Record<string, unknown>> {
  try {
    return { ...(await run()) };
  } catch (error) {
    if (error instanceof TaskNotFoundError) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `Unknown task: ${taskId}`,
      );
    }
    throw error;
  }
}

/* -- The server ----------------------------------------------------------- */

function factory(): McpServer {
  const mcp = new McpServer(
    { name: "crash-recovery-demo", version: "0.1.0" },
    // Advertises the Tasks extension in the server's capabilities.
    { capabilities: { extensions: { [TASKS_EXTENSION]: {} } } },
  );

  mcp.registerTool(
    "index_corpus",
    {
      description: "Indexes a corpus. Takes long enough to outlive a crash.",
      inputSchema: {},
    },
    async () => {
      const created = await tasks.createTask({ ttlMs: 600_000 });
      // Not awaited: the point of a task is that tools/call returns now.
      void indexCorpus(created.taskId).catch(() => {
        // A worker that dies leaves the durable record as it was; there is
        // nothing to clean up here.
      });
      // The tool callback is typed to return a `CallToolResult`, so a task
      // handle needs the cast. The SDK keeps the explicit `resultType: "task"`.
      return created as never;
    },
  );

  // The engine's results already carry `resultType: "complete"`, so the SDK's
  // encode step keeps them as they are.
  mcp.server.setRequestHandler(
    "tasks/get",
    { params: taskParams },
    ({ taskId }) => answer(taskId, () => tasks.getTask(taskId)),
  );
  // On a 2026-07-28 request the SDK treats a top-level `params.inputResponses`
  // as multi-round-trip material: it removes it from `params` before the
  // schema runs and hands it over as `ctx.mcpReq.inputResponses`, already
  // stripped of entries that are not bare response objects. That is the same
  // field `tasks/update` carries, so this handler reads it from there.
  mcp.server.setRequestHandler(
    "tasks/update",
    { params: taskParams },
    ({ taskId }, ctx) => {
      const inputResponses = ctx.mcpReq.inputResponses;
      if (inputResponses === undefined) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          "tasks/update requires inputResponses",
        );
      }
      return answer(taskId, () =>
        tasks.updateTask(taskId, inputResponses as InputResponses),
      );
    },
  );
  mcp.server.setRequestHandler(
    "tasks/cancel",
    { params: taskParams },
    ({ taskId }) => answer(taskId, () => tasks.cancelTask(taskId)),
  );

  return mcp;
}

const server = createServer(
  toNodeHandler(createMcpHandler(factory, { legacy: "reject" })),
);

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("no port");
  // The demo driver waits for this line rather than sleeping.
  console.log(`listening ${address.port}`);
});

// A SIGKILL cannot be caught — that is the point of the demo. This only covers
// an orderly shutdown, so the log is closed cleanly when one happens.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void tasks.close().finally(() => process.exit(0));
  });
}
