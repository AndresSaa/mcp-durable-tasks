/**
 * The demo, in one command: start a server, defer a task, kill the server
 * outright, start it again, and read the finished result back.
 *
 * Nothing here sleeps waiting for the machine — the driver waits on the
 * server's own "listening" line and on observable task status. That is what
 * makes it safe to record: the timings you see are the work, not padding.
 *
 * Run: `node --experimental-strip-types demo.mts`
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("./server.mts", import.meta.url));
const REVISION = "2026-07-28";
const dir = mkdtempSync(path.join(tmpdir(), "mdt-demo-"));

const say = (line: string) => console.log(line);
const step = (line: string) => console.log(`\n\x1b[1m${line}\x1b[0m`);

let child: ChildProcess | undefined;

/** Starts the server and resolves once it prints the port it bound. */
function start(port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      process.execPath,
      ["--experimental-strip-types", SERVER, dir, String(port)],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    child = proc;
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      const match = chunk.match(/listening (\d+)/);
      if (match) resolve(Number(match[1]));
    });
    proc.once("error", reject);
    proc.once("exit", (code, signal) => {
      if (signal !== "SIGKILL")
        reject(new Error(`server exited (${code}, ${signal})`));
    });
  });
}

/** One JSON-RPC call over the modern wire, headers and envelope included. */
async function rpc(
  port: number,
  method: string,
  params: Record<string, unknown>,
  name?: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": REVISION,
      "Mcp-Method": method,
      ...(name === undefined ? {} : { "Mcp-Name": name }),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": REVISION,
          "io.modelcontextprotocol/clientInfo": {
            name: "demo",
            version: "0.1.0",
          },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  const text = await response.text();
  const frame = text.match(/^data: (.*)$/m);
  const body = JSON.parse(frame ? frame[1]! : text) as {
    result?: Record<string, unknown>;
    error?: { message: string };
  };
  if (body.error) throw new Error(body.error.message);
  return body.result ?? {};
}

const getTask = (port: number, taskId: string) =>
  rpc(port, "tasks/get", { taskId });

try {
  step("1. Start the server and defer some work");
  let port = await start();
  say(`   server listening on ${port}, task state in ${dir}`);

  const created = (await rpc(
    port,
    "tools/call",
    { name: "index_corpus", arguments: {} },
    "index_corpus",
  )) as {
    resultType?: string;
    taskId?: string;
    status?: string;
  };
  const taskId = created.taskId!;
  say(
    `   tools/call returned resultType=${created.resultType} status=${created.status}`,
  );
  say(`   taskId ${taskId}`);
  assert.equal(created.resultType, "task", "tools/call should defer to a task");

  step("2. Poll it, the way a client would");
  for (;;) {
    const view = (await getTask(port, taskId)) as {
      status: string;
      statusMessage?: string;
    };
    say(
      `   tasks/get → ${view.status}${view.statusMessage ? `  (${view.statusMessage})` : ""}`,
    );
    if (view.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  step("3. Kill the server outright — SIGKILL, no shutdown hook, no flush");
  const died = new Promise<void>((resolve) =>
    child!.once("exit", () => resolve()),
  );
  child!.kill("SIGKILL");
  await died;
  say("   process gone. Whatever is on disk is all there is.");

  step("4. Start it again, pointed at the same directory");
  port = await start();
  say(`   server listening on ${port}`);

  step("5. Ask the new process for the task the dead one finished");
  const recovered = (await getTask(port, taskId)) as {
    status: string;
    result?: { content?: { text?: string }[]; indexedAt?: string };
  };
  say(`   tasks/get → ${recovered.status}`);
  say(`   result   → ${JSON.stringify(recovered.result)}`);

  assert.equal(
    recovered.status,
    "completed",
    "the task must survive the crash",
  );
  assert.equal(
    recovered.result?.content?.[0]?.text,
    "indexed 5 files, 0 errors",
    "and so must its result",
  );

  console.log(
    "\n\x1b[32mThe work survived the crash. Nothing was lost, and nothing was re-run.\x1b[0m",
  );
} finally {
  if (
    child !== undefined &&
    child.exitCode === null &&
    child.signalCode === null
  ) {
    child.kill("SIGKILL");
  }
  rmSync(dir, { recursive: true, force: true });
}
