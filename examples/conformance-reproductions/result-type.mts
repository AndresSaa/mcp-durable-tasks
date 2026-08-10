/**
 * Reproduction: a conforming task result is rejected, while the same result
 * with the required discriminator accidentally omitted is accepted as an empty
 * success.
 *
 * Reported as conformance question A10 in `docs/contract.md`.
 *
 * **This is frozen evidence, not a usage example.** The dependency versions are
 * pinned exactly and stay pinned after upstream changes anything, because an
 * issue links to this file at a commit as the measurement it was reviewed
 * against.
 *
 * Run: `node --experimental-strip-types result-type.mts`
 */
import { createServer } from "node:http";
import { strict as assert } from "node:assert";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  createMcpHandler,
  McpServer,
  type CallToolResult,
} from "@modelcontextprotocol/server";

const REVISION = "2026-07-28";
const STAMP = "2026-08-10T00:00:00.000Z";

/** The base task handle the extension says `tools/call` may return instead. */
const taskShape = {
  taskId: "task-abc",
  status: "working",
  createdAt: STAMP,
  lastUpdatedAt: STAMP,
  ttlMs: null,
};

/**
 * The three cases. Note the cast: the typed tool callback is declared to return
 * a `CallToolResult`, so returning a task handle at all requires asserting
 * through it. That cast is part of the finding — the SDK's types give an
 * implementer no way to say "this tool defers".
 */
const CASES: Record<string, CallToolResult> = {
  "task-with-discriminator": {
    resultType: "task",
    ...taskShape,
  } as unknown as CallToolResult,
  "task-missing-discriminator": { ...taskShape } as unknown as CallToolResult,
  "plain-empty-result": { content: [] },
};

function factory(): McpServer {
  const mcp = new McpServer({ name: "a10-reproduction", version: "0.0.0" });
  for (const [name, value] of Object.entries(CASES)) {
    mcp.registerTool(
      name,
      { description: name, inputSchema: {} },
      async () => value,
    );
  }
  return mcp;
}

const handler = createMcpHandler(factory, { legacy: "reject" });
const http = createServer(toNodeHandler(handler));
await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
const address = http.address();
if (address === null || typeof address === "string") throw new Error("no port");
const base = `http://127.0.0.1:${address.port}/`;

/** The exact wire, so the report can quote it rather than describe it. */
async function wire(name: string): Promise<Record<string, unknown>> {
  const response = await fetch(base, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": REVISION,
      "Mcp-Method": "tools/call",
      "Mcp-Name": name,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name,
        arguments: {},
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
  return JSON.parse(frame ? frame[1]! : text) as Record<string, unknown>;
}

// The client must be pinned to the modern era; its default is the 2025 one,
// which a strict modern endpoint rejects outright.
const client = new Client(
  { name: "a10-client", version: "0.0.0" },
  { versionNegotiation: { mode: { pin: REVISION } } },
);
await client.connect(new StreamableHTTPClientTransport(new URL(base)));

const observed: Record<string, unknown> = {};

for (const name of Object.keys(CASES)) {
  const frame = (await wire(name)) as { result?: Record<string, unknown> };
  const entry: Record<string, unknown> = {
    handlerReturned: CASES[name],
    wireResultType: frame.result?.resultType,
    wireContent: frame.result?.content,
  };

  try {
    const result = await client.callTool({ name, arguments: {} });
    entry.client = "resolved";
    entry.clientKeys = Object.keys(result).sort();
  } catch (error) {
    entry.client = "rejected";
    entry.clientCode = (error as { code?: string }).code;
    entry.clientMessage = (error as { message?: string }).message;
  }

  observed[name] = entry;
}

console.log(JSON.stringify({ revision: REVISION, observed }, null, 2));

/* -- The finding, asserted so this file fails if upstream changes ---------- */

const conforming = observed["task-with-discriminator"] as Record<
  string,
  unknown
>;
const omitted = observed["task-missing-discriminator"] as Record<
  string,
  unknown
>;

assert.equal(
  conforming.wireResultType,
  "task",
  "the server should preserve an explicit task discriminator",
);
assert.equal(
  conforming.client,
  "rejected",
  "EXPECTED (as of the report): a conforming task result is rejected by the SDK client",
);
assert.equal(conforming.clientCode, "UNSUPPORTED_RESULT_TYPE");

assert.equal(
  omitted.wireResultType,
  "complete",
  "EXPECTED (as of the report): the server stamps the generic discriminator",
);
assert.equal(
  omitted.client,
  "resolved",
  "EXPECTED (as of the report): the non-conforming result is accepted as a success",
);
assert.deepEqual(
  omitted.clientKeys,
  [
    "_meta",
    "content",
    "createdAt",
    "lastUpdatedAt",
    "status",
    "taskId",
    "ttlMs",
  ],
  "the task fields survive on the client as unknown extra keys",
);

console.log(
  "\nreproduced: the conforming result is rejected; the non-conforming one is accepted as an empty success.",
);

await client.close();
http.close();
