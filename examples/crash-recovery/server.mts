/**
 * A real MCP server whose tasks outlive the process.
 *
 * `tools/call` defers to a task; the task's state lives in a `WalTaskStore` on
 * disk. Kill this process at any moment and start it again: the store replays
 * and `tasks/get` answers from where the dead process left off.
 *
 * ## The one workaround, and why it is here
 *
 * `tasks/get` and `tasks/cancel` cannot be served through the SDK's handler
 * registration on a 2026-07-28 connection. Their names belong to the retired
 * 2025-11-25 method registry, so the protocol-era gate answers `-32601` before
 * any handler runs — see the SDK compatibility profile in `docs/contract.md`.
 *
 * So this answers those two POSTs in HTTP middleware, *before* the SDK sees
 * them, which is what the MCP Inspector does for the same reason. It is a host
 * concern rather than a library one: `mcp-durable-tasks` deliberately does not
 * ship transport code. `tasks/update` needs no workaround — SEP-2663
 * introduced the name and no era claims it.
 */
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { TaskLifecycle } from "mcp-durable-tasks";
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

function factory(): McpServer {
  const mcp = new McpServer({ name: "crash-recovery-demo", version: "0.1.0" });

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
      return created as never;
    },
  );

  return mcp;
}

const mcpHandler = createMcpHandler(factory, { legacy: "reject" });
const nodeHandler = toNodeHandler(mcpHandler);

/** Reads a JSON body without pulling in a framework. */
async function readJson(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
    string,
    unknown
  >;
}

function reply(response: ServerResponse, id: unknown, payload: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ jsonrpc: "2.0", id, result: payload }));
}

function replyError(
  response: ServerResponse,
  id: unknown,
  code: number,
  message: string,
): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }),
  );
}

const server = createServer((request, response) => {
  const method = request.headers["mcp-method"];

  // The interception described at the top of this file. Everything else —
  // initialize, tools/list, tools/call — goes to the SDK untouched.
  if (typeof method === "string" && method.startsWith("tasks/")) {
    void (async () => {
      const body = await readJson(request);
      const id = body.id;
      const params = (body.params ?? {}) as {
        taskId?: string;
        inputResponses?: Record<string, unknown>;
      };
      const taskId = params.taskId ?? "";

      try {
        if (method === "tasks/get")
          return reply(response, id, await tasks.getTask(taskId));
        if (method === "tasks/cancel")
          return reply(response, id, await tasks.cancelTask(taskId));
        if (method === "tasks/update") {
          return reply(
            response,
            id,
            await tasks.updateTask(taskId, params.inputResponses ?? {}),
          );
        }
        return replyError(response, id, -32601, `Method not found: ${method}`);
      } catch (error) {
        // TaskNotFoundError covers "no such task" and "its TTL elapsed"; the
        // extension does not distinguish them, and neither should a server.
        const name = (error as { name?: string }).name;
        if (name === "TaskNotFoundError") {
          return replyError(response, id, -32602, `Unknown task: ${taskId}`);
        }
        throw error;
      }
    })();
    return;
  }

  nodeHandler(request, response);
});

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
