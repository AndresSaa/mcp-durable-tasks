/**
 * Reproduction: on a 2026-07-28 server, `tasks/get` and `tasks/cancel` answer
 * `-32601` before any registered handler runs — including
 * `fallbackRequestHandler` — while `tasks/update` dispatches normally.
 *
 * Reported as conformance question A6 in `docs/contract.md`.
 *
 * **Frozen evidence, not a usage example.** The workarounds this demonstrates
 * the need for are described in the compatibility profile; nothing here is a
 * pattern to copy.
 *
 * Run: `node --experimental-strip-types era-gate.mts`
 */
import { createServer } from "node:http";
import { strict as assert } from "node:assert";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";

const REVISION = "2026-07-28";

/** Every method a registered handler was installed for, plus a control. */
const METHODS = [
  "tasks/get",
  "tasks/update",
  "tasks/cancel",
  "x-durable-tasks/get",
] as const;

const reached: string[] = [];
const fellBackTo: string[] = [];

function factory(): McpServer {
  const mcp = new McpServer({ name: "a6-reproduction", version: "0.0.0" });
  mcp.registerTool(
    "noop",
    { description: "keeps the server non-empty", inputSchema: {} },
    async () => ({
      content: [],
    }),
  );

  for (const method of METHODS) {
    mcp.server.setRequestHandler(
      method,
      // A permissive params schema: what is under test is dispatch, not
      // validation.
      {
        params: {
          "~standard": {
            version: 1,
            vendor: "repro",
            validate: (value: unknown) => ({ value }),
          },
        },
      } as never,
      async () => {
        reached.push(method);
        return { handlerReached: method };
      },
    );
  }

  // A catch-all, to show which unknown methods can still be served.
  mcp.server.fallbackRequestHandler = async (request: { method: string }) => {
    fellBackTo.push(request.method);
    return { viaFallback: request.method };
  };

  return mcp;
}

const handler = createMcpHandler(factory, { legacy: "reject" });
const http = createServer(toNodeHandler(handler));
await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
const address = http.address();
if (address === null || typeof address === "string") throw new Error("no port");
const base = `http://127.0.0.1:${address.port}/`;

async function call(
  method: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(base, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": REVISION,
      "Mcp-Method": method,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        taskId: "t1",
        _meta: {
          "io.modelcontextprotocol/protocolVersion": REVISION,
          "io.modelcontextprotocol/clientInfo": { name: "probe", version: "0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  const text = await response.text();
  const frame = text.match(/^data: (.*)$/m);
  return {
    status: response.status,
    body: JSON.parse(frame ? frame[1]! : text) as Record<string, unknown>,
  };
}

const observed: Record<
  string,
  { status: number; error?: unknown; ok?: boolean }
> = {};

for (const method of [...METHODS, "totally/unknown"]) {
  const { status, body } = await call(method);
  const error = (body as { error?: { code: number; message: string } }).error;
  observed[method] = error ? { status, error } : { status, ok: true };
}

console.log(
  JSON.stringify(
    { revision: REVISION, observed, reached, fellBackTo },
    null,
    2,
  ),
);

/* -- The finding ---------------------------------------------------------- */

for (const blocked of ["tasks/get", "tasks/cancel"] as const) {
  assert.equal(
    (observed[blocked]?.error as { code?: number } | undefined)?.code,
    -32601,
    `EXPECTED (as of the report): ${blocked} is rejected before its handler runs`,
  );
  assert.ok(
    !reached.includes(blocked),
    `${blocked}'s registered handler must never have been invoked`,
  );
}

assert.ok(observed["tasks/update"]?.ok, "tasks/update dispatches normally");
assert.ok(reached.includes("tasks/update"), "its handler runs");
assert.ok(
  reached.includes("x-durable-tasks/get"),
  "a vendor-named control also runs",
);

// The gate sits above the fallback too: an unrelated unknown method reaches it,
// and the blocked task methods do not.
assert.ok(
  fellBackTo.includes("totally/unknown"),
  "an unknown method does reach fallbackRequestHandler",
);
assert.ok(
  !fellBackTo.includes("tasks/get"),
  "EXPECTED (as of the report): tasks/get never reaches the fallback either",
);

console.log(
  "\nreproduced: the era gate rejects tasks/get and tasks/cancel ahead of both the handler map and the fallback.",
);

http.close();
