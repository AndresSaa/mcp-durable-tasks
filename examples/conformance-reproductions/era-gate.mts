/**
 * Measurement: which registration paths can serve `tasks/get`, `tasks/update`
 * and `tasks/cancel` on a 2026-07-28 server, once the request carries the
 * routing headers the extension requires.
 *
 * Conformance question A6 in `docs/contract.md`. On
 * `@modelcontextprotocol/server` 2.0.0 the protocol-era gate answered `-32601`
 * to `tasks/get` and `tasks/cancel` before any handler ran. That historical
 * reproduction is kept at the `v0.2.1` tag. typescript-sdk#2599 (server 2.3.0)
 * exempts those two names from the gate when their handler is registered with
 * an explicit schema; this script measures that claim on the pinned version.
 *
 * Every task request sends `Mcp-Method` and `Mcp-Name: <params.taskId>`. Since
 * server 2.2.0 the HTTP entry rejects a task request without `Mcp-Name` with
 * `-32020` (HTTP 400) before dispatch, so a probe that omits it measures the
 * header check, not the era gate. One control request shows that.
 *
 * It also records where a schema-registered `tasks/update` handler finds the
 * extension's `inputResponses`: the SDK lifts that top-level field out of
 * `params` on every 2026-07-28 request and passes it as
 * `ctx.mcpReq.inputResponses`.
 *
 * **Evidence, not a usage example.** The versions are pinned exactly; the
 * supported pattern lives in `../crash-recovery/server.mts`.
 *
 * Run: `node --experimental-strip-types era-gate.mts`
 */
import { createServer } from "node:http";
import { strict as assert } from "node:assert";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";

const REVISION = "2026-07-28";
const TASK_METHODS = ["tasks/get", "tasks/update", "tasks/cancel"] as const;
const TASK_ID = "t1";
/** What `tasks/update` carries on the wire, per the extension. */
const INPUT_RESPONSES = {
  confirm: { action: "accept", content: { ok: true } },
};

/** A permissive params schema: what is under test is dispatch, not validation. */
const ANY_PARAMS = {
  params: {
    "~standard": {
      version: 1,
      vendor: "repro",
      validate: (value: unknown) => ({ value }),
    },
  },
} as never;

type Mode = "schema" | "typed" | "fallback";

interface Probe {
  registration: Record<string, string>;
  reached: string[];
  fellBackTo: string[];
  /** What a schema-registered `tasks/update` handler was actually given. */
  updateSaw?: { paramsKeys: string[]; ctxInputResponses: unknown };
}

/** One server per registration mode, so no mode can mask another. */
function factoryFor(mode: Mode, probe: Probe): () => McpServer {
  return () => {
    const mcp = new McpServer({ name: `a6-${mode}`, version: "0.0.0" });
    mcp.registerTool(
      "noop",
      { description: "keeps the server non-empty", inputSchema: {} },
      async () => ({ content: [] }),
    );

    for (const method of TASK_METHODS) {
      // The handler returns no `resultType`, so the wire shows what the SDK
      // stamps on its own.
      const answer = async (
        params?: Record<string, unknown>,
        ctx?: { mcpReq: { inputResponses?: Record<string, unknown> } },
      ) => {
        probe.reached.push(method);
        if (method === "tasks/update" && params !== undefined) {
          probe.updateSaw = {
            paramsKeys: Object.keys(params).sort(),
            ctxInputResponses: ctx?.mcpReq.inputResponses,
          };
        }
        return method === "tasks/get"
          ? {
              taskId: TASK_ID,
              status: "working",
              createdAt: "2026-10-12T00:00:00.000Z",
              lastUpdatedAt: "2026-10-12T00:00:00.000Z",
              ttlMs: null,
            }
          : {};
      };
      try {
        if (mode === "schema") {
          mcp.server.setRequestHandler(method, ANY_PARAMS, answer as never);
        } else if (mode === "typed") {
          // The typed overload excludes the task names at the type level, so
          // reaching the runtime path needs the cast.
          (
            mcp.server.setRequestHandler as unknown as (
              method: string,
              handler: () => Promise<unknown>,
            ) => void
          )(method, answer);
        } else {
          continue;
        }
        probe.registration[method] = "accepted";
      } catch (error) {
        probe.registration[method] =
          `threw ${(error as Error).name}: ${(error as Error).message}`;
      }
    }

    if (mode === "fallback") {
      mcp.server.fallbackRequestHandler = async (request: {
        method: string;
      }) => {
        probe.fellBackTo.push(request.method);
        return {};
      };
    }

    return mcp;
  };
}

async function listen(mode: Mode, probe: Probe): Promise<string> {
  const handler = createMcpHandler(factoryFor(mode, probe), {
    legacy: "reject",
  });
  const http = createServer(toNodeHandler(handler));
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (address === null || typeof address === "string")
    throw new Error("no port");
  servers.push(http);
  return `http://127.0.0.1:${address.port}/`;
}

const servers: ReturnType<typeof createServer>[] = [];

interface Outcome {
  status: number;
  error?: { code: number; message: string };
  result?: Record<string, unknown>;
}

async function call(
  base: string,
  method: string,
  { nameHeader = true } = {},
): Promise<Outcome> {
  const response = await fetch(base, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": REVISION,
      "Mcp-Method": method,
      ...(nameHeader ? { "Mcp-Name": TASK_ID } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        taskId: TASK_ID,
        ...(method === "tasks/update"
          ? { inputResponses: INPUT_RESPONSES }
          : {}),
        _meta: {
          "io.modelcontextprotocol/protocolVersion": REVISION,
          "io.modelcontextprotocol/clientInfo": { name: "probe", version: "0" },
          "io.modelcontextprotocol/clientCapabilities": {
            extensions: { "io.modelcontextprotocol/tasks": {} },
          },
        },
      },
    }),
  });
  const text = await response.text();
  const frame = text.match(/^data: (.*)$/m);
  const body = JSON.parse(frame ? frame[1]! : text) as {
    error?: { code: number; message: string };
    result?: Record<string, unknown>;
  };
  return body.error
    ? { status: response.status, error: body.error }
    : { status: response.status, result: body.result };
}

const observed: Record<string, unknown> = {};
const outcomes: Record<Mode, Record<string, Outcome>> = {
  schema: {},
  typed: {},
  fallback: {},
};
const probes: Record<Mode, Probe> = {
  schema: { registration: {}, reached: [], fellBackTo: [] },
  typed: { registration: {}, reached: [], fellBackTo: [] },
  fallback: { registration: {}, reached: [], fellBackTo: [] },
};

for (const mode of ["schema", "typed", "fallback"] as const) {
  const base = await listen(mode, probes[mode]);
  for (const method of TASK_METHODS) {
    outcomes[mode][method] = await call(base, method);
  }
  observed[mode] = { ...probes[mode], responses: outcomes[mode] };
}

// The control: the same schema-registered server, without `Mcp-Name`.
const controlBase = await listen("schema", {
  registration: {},
  reached: [],
  fellBackTo: [],
});
const withoutName = await call(controlBase, "tasks/get", { nameHeader: false });
observed.controlWithoutMcpName = withoutName;

console.log(JSON.stringify({ revision: REVISION, observed }, null, 2));

/* -- The findings, asserted so this file fails if upstream changes -------- */

const code = (outcome: Outcome | undefined) => outcome?.error?.code;

// (a) explicit schema: all three methods reach their handlers.
for (const method of TASK_METHODS) {
  assert.equal(
    outcomes.schema[method]?.status,
    200,
    `schema-registered ${method} is served`,
  );
  assert.ok(outcomes.schema[method]?.result, `${method} returns a result`);
}
assert.deepEqual(probes.schema.reached, [...TASK_METHODS]);

// The SDK stamps the discriminator the handler left out.
for (const method of TASK_METHODS) {
  assert.equal(
    outcomes.schema[method]?.result?.resultType,
    "complete",
    `the SDK stamps resultType "complete" on ${method}`,
  );
}

// The SDK lifts `params.inputResponses` (2026-07-28 multi-round-trip material)
// out of params before the handler runs and surfaces it on the context
// instead, so a `tasks/update` handler must read it from there.
assert.deepEqual(probes.schema.updateSaw, {
  paramsKeys: ["taskId"],
  ctxInputResponses: INPUT_RESPONSES,
});

// (b) typed registration: get and cancel register but stay era-gated; update
// is not a spec method, so the typed overload refuses it outright.
assert.equal(probes.typed.registration["tasks/get"], "accepted");
assert.equal(probes.typed.registration["tasks/cancel"], "accepted");
assert.match(
  probes.typed.registration["tasks/update"] ?? "",
  /^threw TypeError: 'tasks\/update' is not a spec request method/,
);
for (const method of ["tasks/get", "tasks/cancel", "tasks/update"]) {
  assert.equal(
    code(outcomes.typed[method]),
    -32601,
    `typed ${method} answers -32601`,
  );
}
assert.deepEqual(probes.typed.reached, []);

// (c) fallbackRequestHandler: still gated for get and cancel; update, which no
// era claims, falls through to it.
assert.equal(code(outcomes.fallback["tasks/get"]), -32601);
assert.equal(code(outcomes.fallback["tasks/cancel"]), -32601);
assert.equal(outcomes.fallback["tasks/update"]?.status, 200);
assert.deepEqual(probes.fallback.fellBackTo, ["tasks/update"]);

// Control: without `Mcp-Name` the request never reaches dispatch.
assert.equal(withoutName.status, 400);
assert.equal(code(withoutName), -32020);

console.log(
  "\nmeasured: explicit-schema handlers serve all three task methods; typed registration and the fallback stay gated for get and cancel.",
);

for (const http of servers) http.close();
