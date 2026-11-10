/** Host-owned delivery using public SDK 2.4.0 APIs; never imported by the library. */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  PerRequestHTTPServerTransport,
  classifyInboundRequest,
  SUBSCRIPTION_ID_META_KEY,
} from "@modelcontextprotocol/server";
import { MemoryTaskStore, TaskLifecycle } from "../../dist/index.js";

const tasks = new TaskLifecycle({ store: new MemoryTaskStore() });
const a = await tasks.createTask({ ttlMs: null });
const b = await tasks.createTask({ ttlMs: null });
const schema = JSON.parse(
  readFileSync(
    new URL("../../test/fixtures/ext-tasks/schema.json", import.meta.url),
    "utf8",
  ),
);
const ajv = new Ajv2020({
  strict: true,
  allowUnionTypes: true,
  formats: { uri: true, byte: true },
});
ajv.addSchema(schema);
const validate = ajv.getSchema(`${schema.$id}#/$defs/TaskStatusNotification`)!;
let activeListeners = 0;
let nextId = 1;

/** A host routes only subscriptions here; ordinary requests use its normal SDK entry. */
async function subscribe(
  ids: string[],
  authorizedIds: ReadonlySet<string>,
  declared = true,
  beforeSnapshot?: () => Promise<void>,
  taskByteBudget = 1024 * 1024,
) {
  const id = nextId++;
  const body = {
    jsonrpc: "2.0" as const,
    id,
    method: "subscriptions/listen",
    params: {
      notifications: { taskIds: ids },
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": {
          name: "emitter-probe",
          version: "0",
        },
        "io.modelcontextprotocol/clientCapabilities": {
          extensions: declared ? { "io.modelcontextprotocol/tasks": {} } : {},
        },
      },
    },
  };
  const route = classifyInboundRequest({
    httpMethod: "POST",
    protocolVersionHeader: "2026-07-28",
    mcpMethodHeader: "subscriptions/listen",
    body,
  });
  assert.equal(route.kind, "modern");
  if (route.kind !== "modern") throw new Error("classification failed");
  assert.deepEqual(route.message.params?.notifications, { taskIds: ids });
  // The host checks capability and authorization before exposing or registering IDs.
  if (!declared) return { error: -32021 } as const;
  if (ids.some((taskId) => !authorizedIds.has(taskId)))
    return { error: -32602 } as const;
  for (const taskId of ids) await tasks.getTask(taskId);
  const transport = new PerRequestHTTPServerTransport({
    classification: route.classification,
    keepAliveMs: 0,
  });
  const off: (() => void)[] = [];
  let closed = false;
  let ready = false;
  let draining = false;
  let remainingTaskBytes = taskByteBudget;
  // Coalesce by authorized ID: queued state is bounded by this subscription's IDs.
  const dirty = new Set<string>();
  const drain = () => {
    if (closed || !ready || draining) return;
    draining = true;
    void (async () => {
      while (!closed && dirty.size > 0) {
        const taskId = dirty.values().next().value!;
        dirty.delete(taskId);
        const snapshot = await tasks.getTask(taskId);
        const params: Record<string, unknown> = { ...snapshot };
        delete params.resultType;
        if (closed) break;
        const notification = {
          jsonrpc: "2.0",
          method: "notifications/tasks",
          params: { ...params, _meta: { [SUBSCRIPTION_ID_META_KEY]: id } },
        } as const;
        // SDK send() enqueues without backpressure. Cap total task bytes per
        // stream, including framing, and disconnect on exhaustion. Polling or
        // a fresh subscription recovers the current snapshot.
        const bytes =
          new TextEncoder().encode(JSON.stringify(notification)).byteLength +
          32;
        if (bytes > remainingTaskBytes) {
          await transport.close();
          break;
        }
        remainingTaskBytes -= bytes;
        await transport.send(notification, { relatedRequestId: id });
      }
    })()
      .catch(async () => {
        await transport.close();
      })
      .finally(() => {
        draining = false;
        drain();
      });
  };
  const mark = (taskId: string) => {
    dirty.add(taskId);
    drain();
  };
  transport.onclose = () => {
    closed = true;
    dirty.clear();
    for (const unsubscribe of off) {
      unsubscribe();
      activeListeners--;
    }
  };
  for (const taskId of new Set(ids)) {
    off.push(tasks.onTaskChanged(taskId, () => mark(taskId)));
    activeListeners++;
  }
  let dispatch!: Promise<void>;
  transport.onmessage = () => {
    dispatch = (async () => {
      await transport.send(
        {
          jsonrpc: "2.0",
          method: "notifications/subscriptions/acknowledged",
          params: {
            notifications: { taskIds: ids },
            _meta: { [SUBSCRIPTION_ID_META_KEY]: id },
          },
        },
        { relatedRequestId: id },
      );
      await beforeSnapshot?.();
      for (const taskId of ids) dirty.add(taskId);
      ready = true;
      drain();
    })();
  };
  await transport.start();
  const response = await transport.handleMessage(route.message, {
    request: new Request("http://host.example/mcp", { method: "POST" }),
  });
  await dispatch;
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const next = async () => {
    while (!text.includes("\n\n")) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      text += decoder.decode(chunk.value, { stream: true });
    }
    const end = text.indexOf("\n\n");
    const frame = text.slice(0, end);
    text = text.slice(end + 2);
    const message = JSON.parse(frame.match(/^data: (.*)$/m)![1]!);
    assert.equal(message.params._meta[SUBSCRIPTION_ID_META_KEY], id);
    if (message.method === "notifications/tasks")
      assert.ok(validate(message), JSON.stringify(validate.errors));
    return message;
  };
  return {
    next,
    close: () => reader.cancel(),
    ended: async () => (await reader.read()).done,
  };
}

try {
  assert.deepEqual(await subscribe([a.taskId], new Set(), true), {
    error: -32602,
  });
  assert.deepEqual(await subscribe([a.taskId], new Set([a.taskId]), false), {
    error: -32021,
  });
  assert.equal(activeListeners, 0);
  // Commit between listener installation and the initial snapshot.
  const first = await subscribe([a.taskId], new Set([a.taskId]), true, () =>
    tasks.handle(a.taskId).progress("during subscribe"),
  );
  if ("error" in first) throw new Error("unexpected denial");
  assert.equal(
    (await first.next()).method,
    "notifications/subscriptions/acknowledged",
  );
  assert.equal((await first.next()).params.statusMessage, "during subscribe");
  const second = await subscribe([b.taskId], new Set([b.taskId]));
  if ("error" in second) throw new Error("unexpected denial");
  await second.next();
  assert.equal((await second.next()).params.taskId, b.taskId);
  await tasks
    .handle(a.taskId)
    .complete({ content: [{ type: "text", text: "done" }] });
  assert.equal((await first.next()).params.status, "completed");
  await tasks.handle(b.taskId).progress("b only");
  assert.equal((await second.next()).params.taskId, b.taskId);
  await first.close();
  assert.equal(activeListeners, 1);
  const recovered = await subscribe([a.taskId], new Set([a.taskId]));
  if ("error" in recovered) throw new Error("unexpected denial");
  assert.equal(
    (await recovered.next()).method,
    "notifications/subscriptions/acknowledged",
  );
  assert.equal((await recovered.next()).params.status, "completed");
  await recovered.close();
  await second.close();
  assert.equal(activeListeners, 0);
  const capped = await subscribe(
    [a.taskId],
    new Set([a.taskId]),
    true,
    undefined,
    1,
  );
  if ("error" in capped) throw new Error("unexpected denial");
  assert.equal(
    (await capped.next()).method,
    "notifications/subscriptions/acknowledged",
  );
  assert.equal(await capped.ended(), true);
  assert.equal(activeListeners, 0);
  console.log(
    "public SDK host: ack, snapshots, committed changes, authorization, isolation, terminal reconnect and teardown passed",
  );
} finally {
  await tasks.close();
}
