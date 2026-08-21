/**
 * Workflow recorder tests (S5).
 *
 * Drives the REAL recorder against a fake WorkflowEngine (the seam's observer
 * bus) and a fake append sink, covering the locked event->kind projection:
 * run-start is written by start() only, run-end by finish() only (never on
 * workflow/end), phase/log mapping (empty/non-string dropped, durable log cap
 * at WORKFLOW_MAX_DURABLE_LOGS), runId filtering, permanent disable after an
 * append failure (no further writes, no run-end), restore folding ONLY
 * customType "pix-workflow-v1" CustomEntry items (other customTypes and
 * unknown kinds ignored without failing the segment), abandon leaving no
 * terminal record, lifecycle mapping per stopReason, getSnapshot folding the
 * live stream and onViewChange emission on every fold change.
 *
 * Run with: npm exec tsx -- src/main/__tests__/workflow-recorder.test.ts
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  RALPH_TOOL_NAME,
  WORKFLOW_MAX_DURABLE_LOGS,
  WORKFLOW_RECORD_CUSTOM_TYPE,
  WORKFLOW_RECORD_SCHEMA_VERSION,
  WORKFLOW_TOOL_NAME,
  WorkflowRunId,
} from "../../shared/workflow-types.js";
import type {
  PixWorkflowRecord,
  WorkflowMeta,
  WorkflowRunInfo,
  WorkflowViewState,
} from "../../shared/workflow-types.js";
import { WorkflowEngine } from "../workflow/engine/engine.js";
import type { WorkflowEventListener } from "../workflow/engine/engine.js";
import type { WorkflowRun } from "../workflow/engine/runtime-types.js";
import { createWorkflowRecorder } from "../workflow/recorder.js";
import type {
  WorkflowLifecycleEvent,
  WorkflowLifecyclePayload,
  WorkflowRecorder,
} from "../workflow/recorder.js";

// ============================================================================
// Test harness (matches plan-types.test.ts style)
// ============================================================================

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual === expected) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    console.error(
      `  FAIL: ${message} - expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertJson(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    console.error(
      `  FAIL: ${message} - expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

async function run(name: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n=== ${name} ===\n`);
  try {
    await fn();
  } catch (err) {
    failed++;
    console.error(`  FAIL: ${name} threw unexpectedly: ${String(err)}`);
  }
}

// ============================================================================
// Fixtures
// ============================================================================

const RUN_ID = WorkflowRunId("run-1");
const RUN_ID_2 = WorkflowRunId("run-2");
const META: WorkflowMeta = { name: "audit-all", description: "Audit packages" };

function runInfo(id: WorkflowRunId): WorkflowRunInfo {
  return { id, meta: META };
}

function customEntry(customType: string, data: unknown, id: string): SessionEntry {
  return {
    type: "custom",
    customType,
    data,
    id,
    parentId: null,
    timestamp: "2026-08-21T00:00:00.000Z",
  };
}

function sessionInfoEntry(id: string): SessionEntry {
  return { type: "session_info", id, parentId: null, timestamp: "2026-08-21T00:00:00.000Z" };
}

// ============================================================================
// Fake engine: exposes the seam's protected emit as `fire`.
// ============================================================================

class FakeEngine extends WorkflowEngine {
  fire<K extends keyof WorkflowEventListener>(name: K, ...args: Parameters<WorkflowEventListener[K]>): void {
    this.emit(name, ...args);
  }

  start(): WorkflowRun {
    throw new Error("unused in recorder tests");
  }

  disposeAll(): Promise<void> {
    return Promise.resolve();
  }
}

interface Harness {
  recorder: WorkflowRecorder;
  engine: FakeEngine;
  appended: PixWorkflowRecord[];
  lifecycle: Array<{ event: WorkflowLifecycleEvent; payload: WorkflowLifecyclePayload }>;
  views: WorkflowViewState[];
}

/** Recorder wired to a fake engine and append sink; failOn makes append throw. */
function makeHarness(options?: { failOn?: (data: PixWorkflowRecord) => boolean }): Harness {
  const engine = new FakeEngine();
  const appended: PixWorkflowRecord[] = [];
  const lifecycle: Array<{ event: WorkflowLifecycleEvent; payload: WorkflowLifecyclePayload }> = [];
  const views: WorkflowViewState[] = [];
  const recorder = createWorkflowRecorder({
    append: (data) => {
      if (options?.failOn?.(data)) {
        throw new Error("append failed");
      }
      appended.push(data);
    },
    engine,
    onLifecycle: (event, payload) => {
      lifecycle.push({ event, payload });
    },
  });
  recorder.onViewChange((run) => {
    views.push(run);
  });
  return { recorder, engine, appended, lifecycle, views };
}

// ============================================================================
// Tests
// ============================================================================

run("event projection and run-end only via finish", async () => {
  const h = makeHarness();
  h.recorder.start({ id: RUN_ID, meta: META }, "call-1", WORKFLOW_TOOL_NAME);
  assertEqual(h.appended.length, 1, "start appends exactly one record");
  assertJson(
    h.appended[0],
    {
      schemaVersion: WORKFLOW_RECORD_SCHEMA_VERSION,
      kind: "run-start",
      runId: RUN_ID,
      toolCallId: "call-1",
      toolName: "workflow",
      name: "audit-all",
    },
    "run-start record shape",
  );

  h.engine.fire("workflow/start", runInfo(RUN_ID));
  assertEqual(h.appended.length, 1, "workflow/start does not re-write run-start");

  h.engine.fire("workflow/phase", runInfo(RUN_ID), "scan");
  assertJson(h.appended.at(-1), { schemaVersion: 1, kind: "phase", runId: RUN_ID, title: "scan" }, "phase record");

  h.engine.fire("workflow/log", runInfo(RUN_ID), "hello");
  assertJson(h.appended.at(-1), { schemaVersion: 1, kind: "log", runId: RUN_ID, message: "hello" }, "log record");

  h.engine.fire("workflow/agent-start", runInfo(RUN_ID), { seq: 1, label: "audit", phase: "scan", childId: "task-1" });
  assertJson(
    h.appended.at(-1),
    {
      schemaVersion: 1,
      kind: "agent-start",
      runId: RUN_ID,
      seq: 1,
      label: "audit",
      phase: "scan",
      childId: "task-1",
    },
    "agent-start record carries phase when present",
  );

  h.engine.fire("workflow/agent-start", runInfo(RUN_ID), { seq: 2, label: "verify", childId: "task-2" });
  assertJson(
    h.appended.at(-1),
    { schemaVersion: 1, kind: "agent-start", runId: RUN_ID, seq: 2, label: "verify", childId: "task-2" },
    "agent-start record omits phase when absent",
  );

  h.engine.fire("workflow/agent-end", runInfo(RUN_ID), { seq: 1, label: "audit", childId: "task-1", outcome: "completed" });
  assertJson(h.appended.at(-1), { schemaVersion: 1, kind: "agent-end", runId: RUN_ID, seq: 1, outcome: "completed" }, "agent-end record");

  h.engine.fire("workflow/agent-end", runInfo(RUN_ID), { seq: 2, label: "verify", childId: "task-2", outcome: "completed" });
  assertJson(h.appended.at(-1), { schemaVersion: 1, kind: "agent-end", runId: RUN_ID, seq: 2, outcome: "completed" }, "second agent-end record");

  h.engine.fire("workflow/end", runInfo(RUN_ID), { stopReason: "completed", agentsStarted: 2 });
  assert(
    !h.appended.some((record) => record.kind === "run-end"),
    "workflow/end does not write run-end",
  );

  h.recorder.finish(RUN_ID, "completed");
  assertJson(
    h.appended.at(-1),
    { schemaVersion: 1, kind: "run-end", runId: RUN_ID, stopReason: "completed" },
    "finish writes run-end as the terminal record",
  );

  const lastView = h.views.at(-1);
  assert(lastView !== undefined, "onViewChange emitted a view for the run");
  assertEqual(lastView?.status, "completed", "folded status is completed after finish");
  assertEqual(lastView?.toolCallId, "call-1", "view carries toolCallId");
  assertEqual(lastView?.toolName, "workflow", "view carries toolName");
  assertEqual(lastView?.currentPhase, "scan", "view carries currentPhase");
  assertEqual(lastView?.members.length, 2, "view lists both members");
  assertEqual(lastView?.members[0]?.outcome, "completed", "member outcome folded");
  assertEqual(lastView?.members[1]?.outcome, "completed", "second member outcome folded");
  assertEqual(lastView?.logs.length, 1, "view carries the log line");
  assertEqual(
    h.views.length,
    8,
    "one view emission per successful append (start, phase, log, 2x agent-start, 2x agent-end, run-end)",
  );
});

run("phase/log mapping: empty and non-string inputs are dropped", async () => {
  const h = makeHarness();
  h.recorder.start({ id: RUN_ID, meta: META }, "call-1", WORKFLOW_TOOL_NAME);

  h.engine.fire("workflow/phase", runInfo(RUN_ID), "");
  assertEqual(h.appended.length, 1, "empty phase title is dropped");

  h.engine.fire("workflow/phase", runInfo(RUN_ID), 42 as unknown as string);
  assertEqual(h.appended.length, 1, "non-string phase title is dropped");

  h.engine.fire("workflow/log", runInfo(RUN_ID), 42 as unknown as string);
  assertEqual(h.appended.length, 1, "non-string log message is dropped");

  h.engine.fire("workflow/log", runInfo(RUN_ID), "ok");
  assertEqual(h.appended.length, 2, "string log message is appended");
  assertJson(h.appended.at(-1), { schemaVersion: 1, kind: "log", runId: RUN_ID, message: "ok" }, "log record shape");
});

run("durable log cap at WORKFLOW_MAX_DURABLE_LOGS", async () => {
  const h = makeHarness();
  h.recorder.start({ id: RUN_ID, meta: META }, "call-1", WORKFLOW_TOOL_NAME);
  for (let i = 0; i < WORKFLOW_MAX_DURABLE_LOGS; i++) {
    h.engine.fire("workflow/log", runInfo(RUN_ID), `line-${i}`);
  }
  assertEqual(
    h.appended.filter((record) => record.kind === "log").length,
    WORKFLOW_MAX_DURABLE_LOGS,
    "exactly WORKFLOW_MAX_DURABLE_LOGS log records persisted",
  );
  h.engine.fire("workflow/log", runInfo(RUN_ID), "one-too-many");
  assertEqual(
    h.appended.filter((record) => record.kind === "log").length,
    WORKFLOW_MAX_DURABLE_LOGS,
    "the log beyond the cap is dropped",
  );
  assertEqual(
    h.recorder.getSnapshot()[0]?.logs.length,
    WORKFLOW_MAX_DURABLE_LOGS,
    "folded view keeps the full cap",
  );
});

run("events for other runs are filtered", async () => {
  const h = makeHarness();
  h.recorder.start({ id: RUN_ID, meta: META }, "call-1", WORKFLOW_TOOL_NAME);
  h.engine.fire("workflow/phase", runInfo(RUN_ID_2), "other-phase");
  h.engine.fire("workflow/log", runInfo(RUN_ID_2), "other-log");
  h.engine.fire("workflow/agent-start", runInfo(RUN_ID_2), { seq: 1, label: "other", childId: "other-task" });
  h.engine.fire("workflow/end", runInfo(RUN_ID_2), { stopReason: "completed", agentsStarted: 0 });
  assertEqual(h.appended.length, 1, "events for other runs never project");
  h.recorder.finish(RUN_ID_2, "completed");
  assertEqual(h.appended.length, 1, "finish for an unknown run is a no-op");

  const h2 = makeHarness();
  h2.recorder.start({ id: RUN_ID_2, meta: META }, "call-2", RALPH_TOOL_NAME);
  assertJson(
    h2.appended[0],
    {
      schemaVersion: WORKFLOW_RECORD_SCHEMA_VERSION,
      kind: "run-start",
      runId: RUN_ID_2,
      toolCallId: "call-2",
      toolName: "ralph",
      name: "audit-all",
    },
    "ralph run-start carries the ralph toolName",
  );
});

run("append failure disables all further writes", async () => {
  const h = makeHarness({ failOn: (record) => record.kind === "phase" });
  h.recorder.start({ id: RUN_ID, meta: META }, "call-1", WORKFLOW_TOOL_NAME);
  assertEqual(h.appended.length, 1, "run-start appended before the failure");

  h.engine.fire("workflow/phase", runInfo(RUN_ID), "scan");
  assertEqual(h.appended.length, 1, "failed phase append is not persisted");

  h.engine.fire("workflow/log", runInfo(RUN_ID), "after-failure");
  assertEqual(h.appended.length, 1, "no log write after an append failure");

  h.engine.fire("workflow/agent-start", runInfo(RUN_ID), { seq: 1, label: "audit", childId: "task-1" });
  assertEqual(h.appended.length, 1, "no agent-start write after an append failure");

  h.engine.fire("workflow/agent-end", runInfo(RUN_ID), { seq: 1, label: "audit", childId: "task-1", outcome: "completed" });
  assertEqual(h.appended.length, 1, "no agent-end write after an append failure");

  h.recorder.finish(RUN_ID, "completed");
  assertEqual(h.appended.length, 1, "finish writes no run-end after an append failure");

  h.recorder.start({ id: RUN_ID_2, meta: META }, "call-2", WORKFLOW_TOOL_NAME);
  assertEqual(h.appended.length, 1, "a later start writes nothing after an append failure");

  assertEqual(
    h.lifecycle.map((entry) => entry.event).join(","),
    "started,completed",
    "lifecycle still reports the real outcome of the active run",
  );
  assertEqual(h.views.length, 1, "only the run-start fold was emitted");
});

run("failed first append keeps the recorder out of active", async () => {
  const h = makeHarness({ failOn: (record) => record.kind === "run-start" });
  h.recorder.start({ id: RUN_ID, meta: META }, "call-1", WORKFLOW_TOOL_NAME);
  assertEqual(h.appended.length, 0, "failed run-start is not persisted");

  h.engine.fire("workflow/phase", runInfo(RUN_ID), "scan");
  h.engine.fire("workflow/agent-start", runInfo(RUN_ID), { seq: 1, label: "audit", childId: "task-1" });
  assertEqual(h.appended.length, 0, "never writes after a failed first append");

  h.recorder.finish(RUN_ID, "completed");
  h.recorder.abandon(RUN_ID);
  assertEqual(h.lifecycle.length, 0, "no lifecycle events for a run that never started");
  assertEqual(h.views.length, 0, "no view emission for a run that never started");
});

run("restore folds only pix-workflow-v1 custom entries", async () => {
  const h = makeHarness();
  const entries: SessionEntry[] = [
    customEntry(
      WORKFLOW_RECORD_CUSTOM_TYPE,
      { schemaVersion: 1, kind: "run-start", runId: RUN_ID, toolCallId: "call-1", toolName: "workflow", name: "audit-all" },
      "e1",
    ),
    customEntry(WORKFLOW_RECORD_CUSTOM_TYPE, { schemaVersion: 1, kind: "phase", runId: RUN_ID, title: "scan" }, "e2"),
    customEntry(WORKFLOW_RECORD_CUSTOM_TYPE, { schemaVersion: 1, kind: "agent-start", runId: RUN_ID, seq: 1, label: "audit", childId: "task-1" }, "e3"),
    customEntry(WORKFLOW_RECORD_CUSTOM_TYPE, { schemaVersion: 1, kind: "agent-end", runId: RUN_ID, seq: 1, outcome: "completed" }, "e3b"),
    customEntry(WORKFLOW_RECORD_CUSTOM_TYPE, { schemaVersion: 1, kind: "run-end", runId: RUN_ID, stopReason: "completed" }, "e4"),
    // Other customTypes are ignored.
    customEntry("pix-plan-v1", { planId: "plan-1" }, "e5"),
    customEntry("something-else", { x: 1 }, "e6"),
    // Unknown kind inside pix-workflow-v1: skipped, not fatal for the segment.
    customEntry(WORKFLOW_RECORD_CUSTOM_TYPE, { schemaVersion: 1, kind: "future-kind", runId: RUN_ID }, "e7"),
    // Corruption (agent-end without matching agent-start): skipped by the fold.
    customEntry(WORKFLOW_RECORD_CUSTOM_TYPE, { schemaVersion: 1, kind: "agent-end", runId: RUN_ID, seq: 99, outcome: "failed" }, "e8"),
    // A pix-workflow-v1 entry without data has nothing to fold.
    customEntry(WORKFLOW_RECORD_CUSTOM_TYPE, undefined, "e9"),
    // A non-custom entry type is ignored even with the workflow customType.
    sessionInfoEntry("e10"),
  ];

  const runs = h.recorder.restore(entries);
  assertEqual(runs.length, 1, "restore folds exactly the pix-workflow-v1 run");
  assertEqual(runs[0]?.runId, RUN_ID, "restored run id");
  assertEqual(runs[0]?.status, "completed", "restored run folds as completed");
  assertEqual(runs[0]?.toolCallId, "call-1", "restored run carries toolCallId");
  assertEqual(runs[0]?.currentPhase, "scan", "restored run carries currentPhase");
  assertEqual(runs[0]?.members.length, 1, "restored run carries its member");
  assertEqual(runs[0]?.members[0]?.outcome, "completed", "restored member carries its outcome");

  const interrupted = h.recorder.restore([
    customEntry(
      WORKFLOW_RECORD_CUSTOM_TYPE,
      { schemaVersion: 1, kind: "run-start", runId: RUN_ID_2, toolCallId: "call-2", toolName: "ralph", name: "audit-all" },
      "f1",
    ),
    customEntry(WORKFLOW_RECORD_CUSTOM_TYPE, { schemaVersion: 1, kind: "agent-start", runId: RUN_ID_2, seq: 1, label: "audit", childId: "task-1" }, "f2"),
  ]);
  // restore MERGES into the in-memory mirror (dedup by record), so the
  // second call re-folds BOTH restored runs; locate the interrupted one.
  assertEqual(interrupted.length, 2, "restore re-folds the merged mirror");
  const resumed = interrupted.find((run) => run.runId === RUN_ID_2);
  assertEqual(resumed?.status, "running", "missing run-end folds as running");

  // Restored runs JOIN the live fold: a same-instance resync re-push of
  // getSnapshot() keeps them instead of wiping them from the renderer.
  assertEqual(h.recorder.getSnapshot().length, 2, "restored runs enter the live fold");
  assertEqual(h.views.length, 3, "restore emits one view per folded run per call");
});

run("abandon leaves no terminal record", async () => {
  const h = makeHarness();
  h.recorder.start({ id: RUN_ID, meta: META }, "call-1", WORKFLOW_TOOL_NAME);
  h.engine.fire("workflow/agent-start", runInfo(RUN_ID), { seq: 1, label: "audit", childId: "task-1" });
  h.recorder.abandon(RUN_ID);
  assertEqual(h.appended.length, 2, "abandon persists no terminal record");
  assertEqual(h.lifecycle.map((entry) => entry.event).join(","), "started", "abandon fires no lifecycle event");

  h.engine.fire("workflow/phase", runInfo(RUN_ID), "scan");
  assertEqual(h.appended.length, 2, "events after abandon are ignored");
  h.recorder.finish(RUN_ID, "completed");
  assertEqual(h.appended.length, 2, "finish after abandon is a no-op");
  h.recorder.abandon(RUN_ID_2);
  assertEqual(h.appended.length, 2, "abandon for an unknown run is a no-op");
});

run("lifecycle mapping per stopReason", async () => {
  const h = makeHarness();
  h.recorder.start({ id: RUN_ID, meta: META }, "call-1", WORKFLOW_TOOL_NAME);
  h.engine.fire("workflow/agent-start", runInfo(RUN_ID), { seq: 1, label: "audit", childId: "task-1" });
  h.engine.fire("workflow/agent-start", runInfo(RUN_ID), { seq: 2, label: "verify", childId: "task-2" });
  h.engine.fire("workflow/agent-end", runInfo(RUN_ID), { seq: 1, label: "audit", childId: "task-1", outcome: "completed" });
  h.engine.fire("workflow/agent-end", runInfo(RUN_ID), { seq: 2, label: "verify", childId: "task-2", outcome: "completed" });
  h.recorder.finish(RUN_ID, "completed");
  assertEqual(h.lifecycle.length, 2, "completed run fires started + completed");
  assertJson(
    h.lifecycle[0],
    { event: "started", payload: { status: "audit-all" } },
    "started lifecycle payload",
  );
  const completed = h.lifecycle[1];
  assertEqual(completed?.event, "completed", "completed stopReason maps to completed");
  assertEqual(completed?.payload.status, "audit-all", "completed payload carries the run name");
  assertEqual(completed?.payload.counts?.agentsStarted, 2, "completed payload counts agents started");
  assert(
    typeof completed?.payload.durationMs === "number" && completed.payload.durationMs >= 0,
    "completed payload carries a non-negative durationMs",
  );

  const h2 = makeHarness();
  h2.recorder.start({ id: RUN_ID, meta: META }, "call-1", WORKFLOW_TOOL_NAME);
  h2.recorder.finish(RUN_ID, "cancelled");
  assertEqual(h2.lifecycle.at(-1)?.event, "cancelled", "cancelled stopReason maps to cancelled");

  const h3 = makeHarness();
  h3.recorder.start({ id: RUN_ID, meta: META }, "call-1", WORKFLOW_TOOL_NAME);
  h3.recorder.finish(RUN_ID, "error");
  assertEqual(h3.lifecycle.at(-1)?.event, "failed", "error stopReason maps to failed");
});

run("getSnapshot folds the live stream", async () => {
  const h = makeHarness();
  h.recorder.start({ id: RUN_ID, meta: META }, "call-1", WORKFLOW_TOOL_NAME);
  h.engine.fire("workflow/phase", runInfo(RUN_ID), "scan");
  h.engine.fire("workflow/log", runInfo(RUN_ID), "a");
  h.engine.fire("workflow/log", runInfo(RUN_ID), "b");
  h.engine.fire("workflow/agent-start", runInfo(RUN_ID), { seq: 1, label: "audit", childId: "task-1" });
  h.engine.fire("workflow/agent-end", runInfo(RUN_ID), { seq: 1, label: "audit", childId: "task-1", outcome: "cancelled" });

  let snapshot = h.recorder.getSnapshot();
  assertEqual(snapshot.length, 1, "snapshot has the one live run");
  assertEqual(snapshot[0]?.status, "running", "live run folds as running");
  assertEqual(snapshot[0]?.currentPhase, "scan", "live run folds currentPhase");
  assertEqual(snapshot[0]?.logs.length, 2, "live run folds both logs");
  assertEqual(snapshot[0]?.members.length, 1, "live run folds the open member");

  h.recorder.finish(RUN_ID, "error");
  snapshot = h.recorder.getSnapshot();
  assertEqual(snapshot.length, 1, "finished runs stay in the live fold");
  assertEqual(snapshot[0]?.status, "failed", "error stopReason folds to failed");
});

run("onViewChange unsubscribe", async () => {
  const h = makeHarness();
  let extraCalls = 0;
  const unsubscribe = h.recorder.onViewChange(() => {
    extraCalls++;
  });
  unsubscribe();
  h.recorder.start({ id: RUN_ID, meta: META }, "call-1", WORKFLOW_TOOL_NAME);
  assertEqual(extraCalls, 0, "unsubscribed listener is not called");
  assertEqual(h.views.length, 1, "the remaining harness listener still receives views");
});

// ============================================================================

run("summary", async () => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
});
