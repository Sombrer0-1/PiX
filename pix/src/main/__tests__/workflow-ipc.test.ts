/**
 * Workflow IPC tests (PiX 1.4.3, S9).
 *
 * Covers the §4.9 workflow-command / workflow-event contract end-to-end with
 * an INJECTABLE IPC adapter (pure Node, no Electron runtime): illegal
 * command rejection, get_snapshot with and without a generation, live
 * upsert forwarding on recorder fold changes, and the resync semantics
 * (same recorder -> re-push without restore, swapped recorder ->
 * restore(getEntries()) then push, no recorder -> runs: []).
 *
 * IPC harness rule (design plan §3): the test registers the REAL production
 * handlers from ipc-workflow-adapters.ts on a top-level-imported injectable
 * IpcMainLike/WebContentsLike adapter (the fake types come from
 * ipc-plan-adapters.ts); production registerIpcHandlers passes the real
 * ipcMain / win.webContents. ipc-handlers.ts itself cannot be imported from
 * pure Node (its electron import chain fails to load outside the Electron
 * runtime), so the plan/agent-task/workflow registration and dispatch live
 * in pure modules that the IPC tests import directly - no mirror, no
 * lockstep. Command semantics are exercised against the REAL
 * createWorkflowRecorder (same approach as plan-ipc.test.ts using the real
 * PlanController). The 8 resync call sites in ipc-handlers.ts are
 * one-to-one with resyncPlanEventForwarding (grep-verified); this file
 * verifies the push semantics of the hook they invoke.
 *
 * Run with: npm exec tsx -- src/main/__tests__/workflow-ipc.test.ts
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import type { PixCommandResult } from "../../shared/types.js";
import { WorkflowRunId, type PixWorkflowRecord, type WorkflowViewState } from "../../shared/workflow-types.js";
import { WorkflowEngine } from "../workflow/engine/engine.js";
import { createWorkflowRecorder, type WorkflowRecorder } from "../workflow/recorder.js";
import {
  registerWorkflowIpcHandlers,
  resyncWorkflowEventForwarding,
  subscribeWorkflowEventForwarding,
} from "../ipc-workflow-adapters.js";
import type { IpcMainLike, WebContentsLike } from "../ipc-plan-adapters.js";

// ============================================================================
// Test harness (matches plan-ipc.test.ts / plan-types.test.ts style)
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
    console.error(`  FAIL: ${message} - expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
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

/**
 * Assert the result is a failure envelope and return it narrowed so callers
 * can inspect code/error (PixCommandResult is a discriminated union).
 */
function assertFailure(
  result: PixCommandResult,
  message: string,
): { success: false; error: string; code?: string } {
  if (result.success === false) {
    passed++;
    console.log(`  PASS: ${message}`);
    return result;
  }
  failed++;
  console.error(`  FAIL: ${message} - expected failure envelope, got ${JSON.stringify(result)}`);
  return { success: false, error: "" };
}

// ============================================================================
// Fake engine / recorder plumbing (recorder is REAL)
// ============================================================================

class FakeEngine extends WorkflowEngine {
  start(): never {
    throw new Error("workflow-ipc.test: engine.start is not exercised");
  }

  async disposeAll(): Promise<void> {}
}

function makeRecorder(): WorkflowRecorder {
  return createWorkflowRecorder({
    append: () => {},
    engine: new FakeEngine(),
  });
}

/** Build a CustomEntry carrying one pix-workflow-v1 record (restore input). */
function makeEntry(record: PixWorkflowRecord, id: string): SessionEntry {
  return {
    type: "custom",
    id,
    parentId: null,
    timestamp: "2026-08-21T00:00:00.000Z",
    customType: "pix-workflow-v1",
    data: record,
  } as SessionEntry;
}

/**
 * Interrupted-prefix entry stream: run-start + agent-start without run-end
 * folds to a running view (a legal interrupted prefix, not corruption).
 */
function makeInterruptedEntries(): SessionEntry[] {
  const runId = WorkflowRunId("wf-run-1");
  return [
    makeEntry(
      {
        schemaVersion: 1,
        kind: "run-start",
        runId,
        toolCallId: "call_1",
        toolName: "workflow",
        name: "audit",
      },
      "entry-1",
    ),
    makeEntry(
      {
        schemaVersion: 1,
        kind: "agent-start",
        runId,
        seq: 1,
        label: "audit pkg",
        childId: "task-1",
      },
      "entry-2",
    ),
  ];
}

// ============================================================================
// Injectable IPC adapter (pure Node; REAL handlers imported from
// ipc-workflow-adapters.ts - no mirror, no lockstep)
// ============================================================================

class FakeIpcMain implements IpcMainLike {
  private readonly _handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();

  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void {
    this._handlers.set(channel, listener);
  }

  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const listener = this._handlers.get(channel);
    if (!listener) {
      throw new Error(`No handler registered for channel "${channel}"`);
    }
    return listener({}, ...args);
  }
}

class FakeWebContents implements WebContentsLike {
  readonly sent: Array<{ channel: string; args: unknown[] }> = [];

  send(channel: string, ...args: unknown[]): void {
    this.sent.push({ channel, args });
  }

  eventsOn(channel: string): unknown[] {
    return this.sent.filter((message) => message.channel === channel).map((message) => message.args[0]);
  }

  workflowEvents(): Array<{ type: string; runs?: WorkflowViewState[]; run?: WorkflowViewState }> {
    return this.eventsOn("workflow-event") as Array<{ type: string; runs?: WorkflowViewState[]; run?: WorkflowViewState }>;
  }
}

function snapshotEvents(wc: FakeWebContents): Array<{ type: string; runs?: WorkflowViewState[] }> {
  return wc.workflowEvents().filter((event) => event.type === "snapshot");
}

// ============================================================================
// Tests
// ============================================================================

await run("registration: illegal command rejected; no recorder -> get_snapshot returns []", async () => {
  const ipc = new FakeIpcMain();
  registerWorkflowIpcHandlers(ipc, () => null);

  const bogus = (await ipc.invoke("workflow-command", { type: "bogus" })) as PixCommandResult;
  const bogusFailure = assertFailure(bogus, "unknown type rejected");
  assertEqual(bogusFailure.code, "invalid_workflow_command", "invalid_workflow_command code");
  assert(bogusFailure.error.includes("Invalid workflow command"), "error message present");

  const noType = (await ipc.invoke("workflow-command", {})) as PixCommandResult;
  assertFailure(noType, "missing type rejected");

  // No generation is a legitimate empty state, not an error (plan §4.9).
  const snapshot = (await ipc.invoke("workflow-command", { type: "get_snapshot" })) as PixCommandResult<WorkflowViewState[]>;
  assertEqual(snapshot.success, true, "get_snapshot succeeds without a recorder");
  if (snapshot.success === true) {
    assertEqual(snapshot.data.length, 0, "no generation -> []");
  }
});

await run("get_snapshot: live recorder fold returned in the envelope", async () => {
  const recorder = makeRecorder();
  const runId = WorkflowRunId("wf-run-1");
  recorder.start({ id: runId, meta: { name: "audit", description: "Audit packages" } }, "call_1", "workflow");
  recorder.finish(runId, "completed");

  const ipc = new FakeIpcMain();
  registerWorkflowIpcHandlers(ipc, () => recorder);
  const result = (await ipc.invoke("workflow-command", { type: "get_snapshot" })) as PixCommandResult<WorkflowViewState[]>;
  assertEqual(result.success, true, "get_snapshot succeeds");
  if (result.success === true) {
    assertEqual(result.data.length, 1, "folded state returned");
    const view = result.data[0]!;
    assertEqual(view.runId, runId, "view runId");
    assertEqual(view.toolCallId, "call_1", "view toolCallId");
    assertEqual(view.name, "audit", "view name");
    assertEqual(view.status, "completed", "run-start + run-end folds to completed");
    assertEqual(view.stopReason, "completed", "view stopReason");
    assertEqual(view.members.length, 0, "no members");
  }
});

await run("event forwarding: baseline snapshot, live upserts, unsubscribe stops", async () => {
  const recorder = makeRecorder();
  const webContents = new FakeWebContents();
  const unsubscribe = subscribeWorkflowEventForwarding(
    () => webContents,
    () => recorder,
    () => [],
  );

  // Initial sync: a recorder exists but has no entries; one snapshot runs: [].
  assertEqual(snapshotEvents(webContents).length, 1, "baseline snapshot pushed on subscribe");
  assertEqual(snapshotEvents(webContents)[0]!.runs!.length, 0, "baseline snapshot is empty");

  // Live fold changes arrive as upserts (low frequency: start/phase/log/member/end).
  const runId = WorkflowRunId("wf-run-2");
  recorder.start({ id: runId, meta: { name: "ralph-loop", description: "Iterate" } }, "call_2", "ralph");
  let upserts = webContents.workflowEvents().filter((event) => event.type === "upsert");
  assertEqual(upserts.length, 1, "run-start fold upserted");
  assertEqual(upserts[0]!.run!.status, "running", "upsert view is running");
  assertEqual(upserts[0]!.run!.runId, runId, "upsert runId");
  assertEqual(upserts[0]!.run!.toolName, "ralph", "upsert toolName");

  recorder.finish(runId, "completed");
  upserts = webContents.workflowEvents().filter((event) => event.type === "upsert");
  assertEqual(upserts.length, 2, "run-end fold upserted");
  assertEqual(upserts[1]!.run!.status, "completed", "completed view upserted");

  // Unsubscribe stops both live forwarding and the module-level resync hook.
  unsubscribe();
  const beforeCount = webContents.workflowEvents().length;
  const runId2 = WorkflowRunId("wf-run-3");
  recorder.start({ id: runId2, meta: { name: "audit", description: "Audit packages" } }, "call_3", "workflow");
  resyncWorkflowEventForwarding();
  assertEqual(webContents.workflowEvents().length, beforeCount, "unsubscribe stops forwarding and resync");
});

await run("command-time re-sync pushes a snapshot before get_snapshot", async () => {
  const recorder = makeRecorder();
  const webContents = new FakeWebContents();
  subscribeWorkflowEventForwarding(
    () => webContents,
    () => recorder,
    () => [],
  );

  const ipc = new FakeIpcMain();
  registerWorkflowIpcHandlers(ipc, () => recorder);
  await ipc.invoke("workflow-command", { type: "get_snapshot" });

  // Baseline subscribe sync + command-time re-sync.
  assertEqual(snapshotEvents(webContents).length, 2, "command-time re-sync pushes a snapshot");
});

await run("resync: same recorder re-push keeps restored runs (restore merges into records)", async () => {
  const recorder = makeRecorder();
  const entries = makeInterruptedEntries();
  const webContents = new FakeWebContents();
  let current: WorkflowRecorder | null = recorder;
  const unsubscribe = subscribeWorkflowEventForwarding(
    () => webContents,
    () => current,
    () => entries,
  );

  // Attaching to a fresh recorder restores the injected entries; the folded
  // interrupted prefix is the snapshot payload (restore emits no upserts:
  // the live subscription attaches only after restore).
  assertEqual(snapshotEvents(webContents).length, 1, "subscribe pushes one snapshot");
  const initial = snapshotEvents(webContents)[0]!;
  assertEqual(initial.runs!.length, 1, "restored runs folded into the snapshot");
  assertEqual(initial.runs![0]!.status, "running", "interrupted prefix folds to running");
  assertEqual(initial.runs![0]!.toolCallId, "call_1", "restored view toolCallId");
  assertEqual(initial.runs![0]!.members.length, 1, "restored member present");
  assertEqual(initial.runs![0]!.members[0]!.childId, "task-1", "restored member childId");
  assertEqual(webContents.workflowEvents().filter((event) => event.type === "upsert").length, 0, "restore emits no upserts");

  // Same instance: re-push the recorder's current fold. restore MERGED the
  // entries into the in-memory mirror, so the re-push carries the restored
  // run instead of wiping it from the renderer mirror.
  resyncWorkflowEventForwarding();
  assertEqual(snapshotEvents(webContents).length, 2, "same-instance resync pushes exactly one snapshot");
  const rePushed = snapshotEvents(webContents)[1]!;
  assertEqual(rePushed.runs!.length, 1, "re-push keeps the restored run");
  assertEqual(rePushed.runs![0]!.status, "running", "re-pushed run is still the interrupted prefix");
  assertEqual(webContents.workflowEvents().filter((event) => event.type === "upsert").length, 0, "no restore on same instance");

  // A stable re-sync again: still exactly one snapshot per call.
  resyncWorkflowEventForwarding();
  assertEqual(snapshotEvents(webContents).length, 3, "every same-instance re-sync pushes a snapshot");
  unsubscribe();
});

await run("resync: recorder swap restores entries and pushes the folded snapshot", async () => {
  const first = makeRecorder();
  const second = makeRecorder();
  const entries = makeInterruptedEntries();
  const webContents = new FakeWebContents();
  let current: WorkflowRecorder | null = first;
  const unsubscribe = subscribeWorkflowEventForwarding(
    () => webContents,
    () => current,
    () => entries,
  );
  assertEqual(snapshotEvents(webContents).length, 1, "subscribe pushes the first recorder snapshot");

  // Generation switch: the bridge replaces the recorder instance; the
  // re-sync must re-restore the entries into the replacement and push its
  // folded snapshot (all 8 ipc-handlers sites go through this hook).
  current = second;
  resyncWorkflowEventForwarding();
  assertEqual(snapshotEvents(webContents).length, 2, "swap resync pushes exactly one snapshot");
  const swapped = snapshotEvents(webContents)[1]!;
  assertEqual(swapped.runs!.length, 1, "replacement recorder folded the restored entries");
  assertEqual(swapped.runs![0]!.status, "running", "restored view status");
  assertEqual(webContents.workflowEvents().filter((event) => event.type === "upsert").length, 0, "restore emits no upserts");

  // Same-instance resync after the swap: the restored run SURVIVES because
  // restore merged it into the replacement's in-memory mirror (G2 regression:
  // this re-push used to wipe it).
  resyncWorkflowEventForwarding();
  assertEqual(snapshotEvents(webContents).length, 3, "post-swap same-instance resync pushes one snapshot");
  assertEqual(snapshotEvents(webContents)[2]!.runs!.length, 1, "restored run survives the post-swap re-push");

  // The replacement recorder's live events flow after the swap.
  const runId = WorkflowRunId("wf-run-2");
  second.start({ id: runId, meta: { name: "audit", description: "Audit packages" } }, "call_2", "workflow");
  const upserts = webContents.workflowEvents().filter((event) => event.type === "upsert");
  assertEqual(upserts.length, 1, "live append on the replacement recorder upserts");
  assertEqual(upserts[0]!.run!.runId, runId, "upsert runId");

  // Recorder becomes null (e.g. stop-pi): unsubscribe the old instance and
  // push runs: [].
  current = null;
  resyncWorkflowEventForwarding();
  assertEqual(snapshotEvents(webContents).length, 4, "null recorder resync pushes a snapshot");
  assertEqual(snapshotEvents(webContents)[3]!.runs!.length, 0, "no recorder -> runs: []");
  assertEqual(webContents.workflowEvents().filter((event) => event.type === "upsert").length, 1, "null swap adds no upserts");
  unsubscribe();
});

await run("resync: no recorder pushes runs: []", async () => {
  const webContents = new FakeWebContents();
  const unsubscribe = subscribeWorkflowEventForwarding(
    () => webContents,
    () => null,
    () => [],
  );
  assertEqual(snapshotEvents(webContents).length, 1, "subscribe with no recorder pushes one snapshot");
  assertEqual(snapshotEvents(webContents)[0]!.runs!.length, 0, "empty runs on subscribe");

  resyncWorkflowEventForwarding();
  assertEqual(snapshotEvents(webContents).length, 2, "null recorder re-sync pushes runs: []");
  assertEqual(snapshotEvents(webContents)[1]!.runs!.length, 0, "empty runs on re-sync");
  unsubscribe();
});

// ============================================================================
// Source gate (S9): the resync hook semantics are covered above; the WIRING
// (every session-switch path in ipc-handlers.ts calling the hook) can only be
// guarded against the source itself - deleting a call site must fail here.
// ============================================================================

await run("source gate: ipc-handlers keeps all 8 workflow resync call sites wired", async () => {
  const source = readFileSync(new URL("../ipc-handlers.ts", import.meta.url), "utf8");
  const count = (source.match(/resyncWorkflowEventForwarding\(\)/g) ?? []).length;
  assertEqual(count, 8, "ipc-handlers.ts keeps all 8 resyncWorkflowEventForwarding() call sites");
});

// ============================================================================

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
