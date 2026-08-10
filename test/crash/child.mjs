// The victim process for the crash tests.
//
// It runs against `dist/`, not `src/`: `pnpm test` builds first, so this
// exercises the artifact a consumer actually installs — bundled, dual-format,
// resolved through the `exports` map. A crash test that only proves the
// TypeScript sources recover would be testing the wrong thing.
//
// Every scenario reaches a known state, tells the parent with an IPC message,
// and then stays alive doing nothing. The parent kills it on that message.
// There are no sleeps anywhere: the sync point is the message, so the process
// is provably in the intended state when the signal arrives.

import { TaskLifecycle } from "../../dist/index.js";
import { WalTaskStore } from "../../dist/wal.js";

const [dir, scenario] = process.argv.slice(2);

const announce = (message) => {
  process.send?.(message);
};

/** Keeps the event loop alive so the parent, not the child, decides the end. */
const waitToBeKilled = () => {
  setInterval(() => {}, 1_000);
};

const store = new WalTaskStore({ dir, compactEvery: null });
const engine = new TaskLifecycle({ store, sweepIntervalMs: null });

switch (scenario) {
  case "created": {
    // Nothing has happened since creation. The task must still be recoverable
    // as `working`, which is the weakest and most important case: it is the
    // acknowledgement the server already gave the client.
    const created = await engine.createTask({ ttlMs: null });
    announce({ ready: true, taskId: created.taskId });
    waitToBeKilled();
    break;
  }

  case "input-required": {
    const created = await engine.createTask({ ttlMs: null });
    const handle = engine.handle(created.taskId);

    // Not awaited: it only settles once the client answers, which never
    // happens here. What matters is the durable state it parks.
    void handle
      .requestInput({
        "round-1-roots": { method: "roots/list" },
        "round-1-elicit": {
          method: "elicitation/create",
          params: {
            message: "Continue?",
            requestedSchema: { type: "object", properties: {} },
          },
        },
      })
      .catch(() => {});

    // Poll the wire view rather than guessing: the task is parked only when
    // tasks/get says so, and that is the same thing a client would observe.
    for (;;) {
      const view = await engine.getTask(created.taskId);
      if (view.status === "input_required") break;
      await new Promise((resolve) => setImmediate(resolve));
    }

    announce({ ready: true, taskId: created.taskId });
    waitToBeKilled();
    break;
  }

  case "completed": {
    const created = await engine.createTask({ ttlMs: null });
    await engine.handle(created.taskId).complete({
      content: [{ type: "text", text: "the work finished" }],
      marker: "kept-across-the-crash",
    });
    // The signal arrives immediately after complete() resolved, which is the
    // moment the durability promise has to hold.
    announce({ ready: true, taskId: created.taskId });
    waitToBeKilled();
    break;
  }

  case "expiring": {
    const created = await engine.createTask({ ttlMs: 50 });
    announce({ ready: true, taskId: created.taskId });
    waitToBeKilled();
    break;
  }

  case "mid-append": {
    // Establish and report a mutation that definitely returned before racing
    // the next writes. The parent can now distinguish "no update started" from
    // a regression that lost an acknowledged progress record.
    const created = await engine.createTask({ ttlMs: null });
    const handle = engine.handle(created.taskId);
    const committedStatusMessage = "committed before the crash";
    await handle.progress(committedStatusMessage);
    const committed = await store.get(created.taskId);
    announce({
      ready: true,
      taskId: created.taskId,
      committedVersion: committed.version,
      committedStatusMessage,
    });

    const filler = "x".repeat(64 * 1024);
    for (let round = 1; ; round += 1) {
      await handle.progress(`round ${round} ${filler}`);
    }
  }

  case "mid-compaction": {
    const created = await engine.createTask({ ttlMs: null });
    const handle = engine.handle(created.taskId);
    await handle.progress("primary committed before compaction");

    const fillerTaskIds = [];
    const blob = "c".repeat(256 * 1024);
    for (let index = 0; index < 8; index += 1) {
      const taskId = `compaction-filler-${index}`;
      fillerTaskIds.push(taskId);
      await store.create({
        taskId,
        status: "completed",
        createdAt: "2026-08-10T00:00:00.000Z",
        lastUpdatedAt: "2026-08-10T00:00:00.000Z",
        ttlMs: null,
        version: 0,
        result: { marker: taskId, blob },
      });
    }

    // Complete one real snapshot/checkpoint/compact cycle before announcing,
    // then keep starting more large snapshots until the parent kills us. The
    // committed baseline is known even when the exact interrupted phase is not.
    store.compact();
    const committed = await store.get(created.taskId);
    announce({
      ready: true,
      taskId: created.taskId,
      committedVersion: committed.version,
      fillerTaskIds,
    });
    for (;;) {
      store.compact();
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  default:
    throw new Error(`unknown scenario: ${scenario}`);
}
