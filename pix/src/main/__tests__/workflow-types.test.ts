/**
 * Shared workflow contract tests (S0).
 *
 * Independently verifies pix/src/shared/workflow-types.ts: the locked
 * constants, the guards (isWorkflowToolDetails / isWorkflowCommand /
 * isWorkflowViewState), workflowPhaseKey identity semantics ("" vs undefined),
 * projectWorkflowStatus projection, foldWorkflowRecords invariant
 * enforcement over durable record streams (interrupted prefixes are legal,
 * corruption and unknown kinds are skipped without failing the stream, logs
 * are capped at WORKFLOW_MAX_DURABLE_LOGS), optional WorkflowChildStats.replayed,
 * and WorkflowSalvage types (not on WorkflowResult / WorkflowToolDetails).
 * Does not depend on the engine, recorder or any other workflow module, so
 * these tests run standalone.
 *
 * Run with: npm exec tsx -- src/main/__tests__/workflow-types.test.ts
 */

import {
  RALPH_TOOL_NAME,
  STRUCTURED_OUTPUT_TOOL_NAME,
  WORKFLOW_MAX_DURABLE_LOGS,
  WORKFLOW_RECORD_CUSTOM_TYPE,
  WORKFLOW_RECORD_SCHEMA_VERSION,
  WORKFLOW_TOOL_NAME,
  WorkflowRunId,
  foldWorkflowRecords,
  isWorkflowCommand,
  isWorkflowToolDetails,
  isWorkflowViewState,
  projectWorkflowStatus,
  workflowPhaseKey,
} from "../../shared/workflow-types.js";
import type {
  PixWorkflowRecord,
  WorkflowChildStats,
  WorkflowResult,
  WorkflowSalvage,
  WorkflowSalvageChild,
  WorkflowToolDetails,
  WorkflowViewState,
} from "../../shared/workflow-types.js";

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
// Fixture helpers (return unknown so malformed variants are easy to build)
// ============================================================================

const RUN_ID = WorkflowRunId("run-1");
const RUN_ID_2 = WorkflowRunId("run-2");

function makeRunStartInput(overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: WORKFLOW_RECORD_SCHEMA_VERSION,
    kind: "run-start",
    runId: RUN_ID,
    toolCallId: "tool-1",
    toolName: "workflow",
    name: "audit-all",
    ...overrides,
  };
}

function makePhaseInput(overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: WORKFLOW_RECORD_SCHEMA_VERSION,
    kind: "phase",
    runId: RUN_ID,
    title: "scan",
    ...overrides,
  };
}

function makeLogInput(overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: WORKFLOW_RECORD_SCHEMA_VERSION,
    kind: "log",
    runId: RUN_ID,
    message: "starting audit",
    ...overrides,
  };
}

function makeAgentStartInput(overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: WORKFLOW_RECORD_SCHEMA_VERSION,
    kind: "agent-start",
    runId: RUN_ID,
    seq: 1,
    label: "audit pkg",
    childId: "task-1",
    ...overrides,
  };
}

function makeAgentEndInput(overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: WORKFLOW_RECORD_SCHEMA_VERSION,
    kind: "agent-end",
    runId: RUN_ID,
    seq: 1,
    outcome: "completed",
    ...overrides,
  };
}

function makeRunEndInput(overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: WORKFLOW_RECORD_SCHEMA_VERSION,
    kind: "run-end",
    runId: RUN_ID,
    stopReason: "completed",
    ...overrides,
  };
}

/** Fold an arbitrary (possibly malformed) record stream, cast for typing. */
function fold(records: unknown[]): WorkflowViewState[] {
  return foldWorkflowRecords(records as unknown as PixWorkflowRecord[]);
}

/** A complete legal run: start -> phase/log/member -> end. */
function completeRunStream(runId: unknown = RUN_ID): unknown[] {
  return [
    makeRunStartInput({ runId }),
    makePhaseInput({ runId, title: "scan" }),
    makeLogInput({ runId, message: "member 1" }),
    makeAgentStartInput({ runId, seq: 1, label: "a", childId: "t-1", phase: "scan" }),
    makeAgentEndInput({ runId, seq: 1, outcome: "completed" }),
    makeRunEndInput({ runId, stopReason: "completed" }),
  ];
}

function makeViewInput(overrides: Record<string, unknown> = {}): unknown {
  return {
    runId: RUN_ID,
    toolCallId: "tool-1",
    toolName: "workflow",
    name: "audit-all",
    members: [
      { seq: 1, label: "a", childId: "t-1", outcome: "completed" },
    ],
    logs: [{ message: "member 1" }],
    currentPhase: "scan",
    stopReason: "completed",
    status: "completed",
    ...overrides,
  };
}

function makeDetailsInput(overrides: Record<string, unknown> = {}): unknown {
  return {
    kind: "pix-workflow-run",
    schemaVersion: WORKFLOW_RECORD_SCHEMA_VERSION,
    view: makeViewInput(),
    value: { ok: true },
    agentsStarted: 1,
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

await run("contract constants match the locked values", async () => {
  assertEqual(WORKFLOW_RECORD_CUSTOM_TYPE, "pix-workflow-v1", "WORKFLOW_RECORD_CUSTOM_TYPE === pix-workflow-v1");
  assertEqual(WORKFLOW_RECORD_SCHEMA_VERSION, 1, "WORKFLOW_RECORD_SCHEMA_VERSION === 1");
  assertEqual(WORKFLOW_TOOL_NAME, "workflow", "WORKFLOW_TOOL_NAME === workflow");
  assertEqual(RALPH_TOOL_NAME, "ralph", "RALPH_TOOL_NAME === ralph");
  assertEqual(
    STRUCTURED_OUTPUT_TOOL_NAME,
    "submit_workflow_result",
    "STRUCTURED_OUTPUT_TOOL_NAME === submit_workflow_result",
  );
  assertEqual(WORKFLOW_MAX_DURABLE_LOGS, 200, "WORKFLOW_MAX_DURABLE_LOGS === 200");
});

await run("WorkflowRunId brands its input", async () => {
  const id = WorkflowRunId("abc");
  assertEqual(id, "abc", "WorkflowRunId returns the input string");
  assertEqual(typeof id, "string", "WorkflowRunId result is a string at runtime");
});

await run("workflowPhaseKey: empty string and missing are distinct identities", async () => {
  assertEqual(workflowPhaseKey(undefined), "missing", "undefined phase keys to 'missing'");
  assertEqual(workflowPhaseKey(""), "value:0:", "empty string phase keys to 'value:0:'");
  assertEqual(workflowPhaseKey("scan"), "value:4:scan", "phase 'scan' keys to 'value:4:scan'");
  assertEqual(
    workflowPhaseKey("a\nb"),
    "value:3:a\nb",
    "phase length counts JS characters (newline included)",
  );
  assert(
    workflowPhaseKey("") !== workflowPhaseKey(undefined),
    "empty string and undefined are different phase identities",
  );
});

await run("projectWorkflowStatus projects stopReason to run status", async () => {
  const base = {
    runId: RUN_ID,
    toolCallId: "tool-1",
    toolName: "workflow" as const,
    name: "audit-all",
    members: [],
    logs: [],
  };
  assertEqual(
    projectWorkflowStatus({ ...base, stopReason: "completed" }),
    "completed",
    "completed -> completed",
  );
  assertEqual(
    projectWorkflowStatus({ ...base, stopReason: "cancelled" }),
    "cancelled",
    "cancelled -> cancelled",
  );
  assertEqual(projectWorkflowStatus({ ...base, stopReason: "error" }), "failed", "error -> failed");
  assertEqual(projectWorkflowStatus(base), "running", "missing stopReason -> running");
});

await run("foldWorkflowRecords: empty stream folds to no runs", async () => {
  const runs = fold([]);
  assertEqual(runs.length, 0, "empty records -> empty runs");
});

await run("foldWorkflowRecords: complete run folds to a completed view", async () => {
  const runs = fold(completeRunStream());
  assertEqual(runs.length, 1, "one run folded");
  const view = runs[0];
  assertEqual(view.runId, RUN_ID, "runId preserved");
  assertEqual(view.toolCallId, "tool-1", "toolCallId preserved");
  assertEqual(view.toolName, "workflow", "toolName preserved");
  assertEqual(view.name, "audit-all", "name preserved");
  assertEqual(view.currentPhase, "scan", "currentPhase is the latest phase");
  assertEqual(view.stopReason, "completed", "stopReason preserved");
  assertEqual(view.status, "completed", "status derived completed");
  assertEqual(view.members.length, 1, "one member");
  assertEqual(view.members[0].seq, 1, "member seq preserved");
  assertEqual(view.members[0].label, "a", "member label preserved");
  assertEqual(view.members[0].phase, "scan", "member phase preserved");
  assertEqual(view.members[0].childId, "t-1", "member childId preserved");
  assertEqual(view.members[0].outcome, "completed", "member outcome preserved");
  assertEqual(view.logs.length, 1, "one log line");
  assertEqual(view.logs[0].message, "member 1", "log message preserved");
});

await run("foldWorkflowRecords: interrupted prefix (run-start + agent-start without end) is running", async () => {
  const runs = fold([makeRunStartInput(), makeAgentStartInput()]);
  assertEqual(runs.length, 1, "one run folded");
  assertEqual(runs[0].status, "running", "missing run-end/member-end is a legal interrupted prefix -> running");
  assertEqual(runs[0].stopReason, undefined, "no stopReason on an interrupted prefix");
  assertEqual(runs[0].members.length, 1, "started member present");
  assertEqual(runs[0].members[0].outcome, undefined, "member without end has no outcome");
});

await run("foldWorkflowRecords: run-end with open members is corruption (skipped)", async () => {
  const runs = fold([
    makeRunStartInput(),
    makeAgentStartInput(),
    makeRunEndInput({ stopReason: "cancelled" }),
  ]);
  assertEqual(runs.length, 1, "one run folded");
  assertEqual(runs[0].stopReason, undefined, "run-end with open members skipped");
  assertEqual(runs[0].status, "running", "run stays running after skipped run-end");
});

await run("foldWorkflowRecords: failed and cancelled outcomes/stopReasons fold", async () => {
  const runs = fold([
    makeRunStartInput(),
    makeAgentStartInput({ seq: 1 }),
    makeAgentEndInput({ seq: 1, outcome: "failed" }),
    makeAgentStartInput({ seq: 2, label: "b", childId: "t-2" }),
    makeAgentEndInput({ seq: 2, outcome: "cancelled" }),
    makeRunEndInput({ stopReason: "cancelled" }),
  ]);
  assertEqual(runs[0].stopReason, "cancelled", "stopReason cancelled preserved");
  assertEqual(runs[0].status, "cancelled", "status derived cancelled");
  assertEqual(runs[0].members[0].outcome, "failed", "failed member outcome preserved");
  assertEqual(runs[0].members[1].outcome, "cancelled", "cancelled member outcome preserved");
});

await run("foldWorkflowRecords: ralph runs fold with toolName ralph", async () => {
  const runs = fold([
    makeRunStartInput({ toolName: "ralph" }),
    makeAgentStartInput(),
    makeAgentEndInput(),
    makeRunEndInput({ stopReason: "error" }),
  ]);
  assertEqual(runs[0].toolName, "ralph", "ralph run preserves toolName");
  assertEqual(runs[0].status, "failed", "error stopReason -> failed status");
});

await run("foldWorkflowRecords: logs are capped at WORKFLOW_MAX_DURABLE_LOGS (latest kept)", async () => {
  const total = WORKFLOW_MAX_DURABLE_LOGS + 5;
  const records: unknown[] = [makeRunStartInput()];
  for (let i = 1; i <= total; i++) {
    records.push(makeLogInput({ message: `line ${i}` }));
  }
  const runs = fold(records);
  assertEqual(runs[0].logs.length, WORKFLOW_MAX_DURABLE_LOGS, "log count capped at 200");
  assertEqual(runs[0].logs[0].message, "line 6", "oldest logs dropped (first kept is line 6)");
  assertEqual(
    runs[0].logs[WORKFLOW_MAX_DURABLE_LOGS - 1].message,
    `line ${total}`,
    "latest log kept",
  );
});

await run("foldWorkflowRecords: duplicate run-start is corruption (skipped)", async () => {
  const runs = fold([makeRunStartInput(), makeRunStartInput()]);
  assertEqual(runs.length, 1, "second run-start for the same runId skipped");
  assertEqual(runs[0].name, "audit-all", "first run-start wins");
});

await run("foldWorkflowRecords: records without a prior run-start are skipped", async () => {
  const runs = fold([
    makePhaseInput(),
    makeLogInput(),
    makeAgentStartInput(),
    makeAgentEndInput(),
    makeRunEndInput(),
  ]);
  assertEqual(runs.length, 0, "no run appears without a run-start");
});

await run("foldWorkflowRecords: records after run-end are skipped", async () => {
  const runs = fold([
    ...completeRunStream(),
    makePhaseInput({ title: "late" }),
    makeLogInput({ message: "late log" }),
    makeAgentStartInput({ seq: 9, childId: "t-9" }),
  ]);
  assertEqual(runs.length, 1, "one run folded");
  assertEqual(runs[0].currentPhase, "scan", "phase after run-end skipped");
  assertEqual(runs[0].logs.length, 1, "log after run-end skipped");
  assertEqual(runs[0].members.length, 1, "agent-start after run-end skipped");
});

await run("foldWorkflowRecords: agent-start invariant violations are skipped (run still folds)", async () => {
  const badSeq = fold([makeRunStartInput(), makeAgentStartInput({ seq: 0 })]);
  assertEqual(badSeq.length, 1, "run folds with seq 0 agent-start skipped");
  assertEqual(badSeq[0].members.length, 0, "seq 0 agent-start skipped");

  assertEqual(fold([makeRunStartInput(), makeAgentStartInput({ seq: -1 })])[0].members.length, 0, "negative seq skipped");
  assertEqual(fold([makeRunStartInput(), makeAgentStartInput({ seq: 1.5 })])[0].members.length, 0, "non-integer seq skipped");
  assertEqual(fold([makeRunStartInput(), makeAgentStartInput({ seq: NaN })])[0].members.length, 0, "NaN seq skipped");
  assertEqual(fold([makeRunStartInput(), makeAgentStartInput({ label: 5 })])[0].members.length, 0, "non-string label skipped");
  assertEqual(fold([makeRunStartInput(), makeAgentStartInput({ childId: "" })])[0].members.length, 0, "empty childId skipped");
  assertEqual(fold([makeRunStartInput(), makeAgentStartInput({ phase: 5 })])[0].members.length, 0, "non-string phase skipped");

  const duplicate = fold([
    makeRunStartInput(),
    makeAgentStartInput({ seq: 1 }),
    makeAgentStartInput({ seq: 1, childId: "t-dup" }),
  ]);
  assertEqual(duplicate.length, 1, "run folds after duplicate seq agent-start");
  assertEqual(duplicate[0].members.length, 1, "duplicate seq within a run skipped");
  assertEqual(duplicate[0].members[0].childId, "task-1", "first agent-start for the seq wins");
});

await run("foldWorkflowRecords: agent-end invariant violations are skipped", async () => {
  const orphan = fold([makeRunStartInput(), makeAgentEndInput({ seq: 99 })]);
  assertEqual(orphan[0].members.length, 0, "agent-end without matching agent-start skipped");

  const dupEnd = fold([
    makeRunStartInput(),
    makeAgentStartInput(),
    makeAgentEndInput(),
    makeAgentEndInput({ outcome: "failed" }),
  ]);
  assertEqual(dupEnd[0].members[0].outcome, "completed", "duplicate agent-end skipped, first outcome wins");

  const withError = fold([
    makeRunStartInput(),
    makeAgentStartInput(),
    makeAgentEndInput({ outcome: "failed", error: "max_turns: exceeded" }),
    makeRunEndInput({ stopReason: "completed" }),
  ]);
  assertEqual(withError[0].members[0].error, "max_turns: exceeded", "agent-end error folds onto the member");

  const badOutcome = fold([makeRunStartInput(), makeAgentStartInput(), makeAgentEndInput({ outcome: "done" })]);
  assertEqual(badOutcome[0].members[0].outcome, undefined, "illegal outcome skipped");
});

await run("foldWorkflowRecords: run-end invariant violations are skipped", async () => {
  const badReason = fold([makeRunStartInput(), makeRunEndInput({ stopReason: "done" })]);
  assertEqual(badReason[0].status, "running", "illegal stopReason skipped; run stays running");
});

await run("foldWorkflowRecords: run-start invariant violations are skipped", async () => {
  assertEqual(fold([makeRunStartInput({ name: "" })]).length, 0, "empty name skipped");
  assertEqual(fold([makeRunStartInput({ name: 5 })]).length, 0, "non-string name skipped");
  assertEqual(fold([makeRunStartInput({ runId: "" })]).length, 0, "empty runId skipped");
  assertEqual(fold([makeRunStartInput({ toolCallId: 5 })]).length, 0, "non-string toolCallId skipped");
  assertEqual(fold([makeRunStartInput({ toolName: "plan" })]).length, 0, "unknown toolName skipped");
});

await run("foldWorkflowRecords: unknown kinds and unsupported schemaVersions are skipped, not fatal", async () => {
  const unknownKind = fold([
    makeRunStartInput(),
    { schemaVersion: WORKFLOW_RECORD_SCHEMA_VERSION, kind: "future-kind", runId: RUN_ID },
    makeAgentStartInput(),
    makeAgentEndInput(),
    makeRunEndInput(),
  ]);
  assertEqual(unknownKind.length, 1, "unknown kind skipped without failing the stream");
  assertEqual(unknownKind[0].status, "completed", "run still completes after an unknown kind");

  const futureVersion = fold([
    { schemaVersion: 2, kind: "run-start", runId: RUN_ID, toolCallId: "t", toolName: "workflow", name: "x" },
    makeRunStartInput(),
    makeRunEndInput(),
  ]);
  assertEqual(futureVersion.length, 1, "schemaVersion 2 record skipped");
  assertEqual(futureVersion[0].name, "audit-all", "v1 run-start still folds after a future-version record");

  const nonObject = fold([
    makeRunStartInput(),
    null,
    42,
    "log",
    makeAgentStartInput(),
    makeAgentEndInput(),
    makeRunEndInput(),
  ]);
  assertEqual(nonObject.length, 1, "non-object records skipped");
  assertEqual(nonObject[0].status, "completed", "run completes with garbage interspersed");
});

await run("foldWorkflowRecords: phase/log shape tolerance (non-string values skipped)", async () => {
  const runs = fold([
    makeRunStartInput(),
    makePhaseInput({ title: 5 }),
    makeLogInput({ message: 7 }),
    makePhaseInput({ title: "" }),
    makeRunEndInput(),
  ]);
  assertEqual(runs[0].logs.length, 0, "non-string log message skipped");
  assertEqual(runs[0].currentPhase, "", "empty-string phase preserved (distinct identity)");
  assertEqual(runs[0].status, "completed", "run completes despite skipped shape violations");
});

await run("foldWorkflowRecords: multiple runs fold in run-start order", async () => {
  const runs = fold([
    ...completeRunStream(RUN_ID),
    ...completeRunStream(RUN_ID_2),
  ]);
  assertEqual(runs.length, 2, "two runs folded");
  assertEqual(runs[0].runId, RUN_ID, "first run in stream order");
  assertEqual(runs[1].runId, RUN_ID_2, "second run in stream order");
  assertEqual(runs[1].name, "audit-all", "second run name preserved");
});

await run("foldWorkflowRecords: never throws on arbitrary input", async () => {
  const garbage: unknown[] = [
    null,
    undefined,
    0,
    "log",
    [],
    Symbol("x"),
    makeAgentStartInput(),
    makeRunEndInput(),
    makeRunStartInput({ name: "" }),
    { kind: "run-start" },
    { schemaVersion: 1 },
  ];
  let threw = false;
  try {
    fold(garbage);
  } catch {
    threw = true;
  }
  assert(!threw, "fold does not throw on arbitrary record input");

  const cyclic: unknown[] = [];
  cyclic.push(cyclic);
  threw = false;
  try {
    fold(cyclic);
  } catch {
    threw = true;
  }
  assert(!threw, "fold does not throw on a cyclic records array");
});

await run("isWorkflowCommand: accepts get_snapshot only", async () => {
  assert(isWorkflowCommand({ type: "get_snapshot" }), "get_snapshot accepted");
  assert(!isWorkflowCommand({ type: "other" }), "other command type rejected");
  assert(!isWorkflowCommand({}), "missing type rejected");
  assert(!isWorkflowCommand("get_snapshot"), "non-object rejected");
  assert(!isWorkflowCommand(null), "null rejected");
  assert(!isWorkflowCommand(undefined), "undefined rejected");
});

await run("isWorkflowViewState: accepts valid views", async () => {
  assert(isWorkflowViewState(makeViewInput()), "valid completed view accepted");

  const running = makeViewInput({
    status: "running",
    stopReason: undefined,
    currentPhase: undefined,
    members: [{ seq: 1, label: "a", childId: "t-1" }],
  });
  assert(isWorkflowViewState(running), "running view with open member accepted");

  const empty = makeViewInput({ members: [], logs: [], currentPhase: undefined, stopReason: undefined, status: "running" });
  assert(isWorkflowViewState(empty), "view with no members/logs accepted");

  for (const status of ["running", "completed", "failed", "cancelled", "interrupted"]) {
    assert(isWorkflowViewState(makeViewInput({ status })), `status ${status} accepted`);
  }
});

await run("isWorkflowViewState: rejects malformed views", async () => {
  assert(!isWorkflowViewState(makeViewInput({ runId: 5 })), "non-string runId rejected");
  assert(!isWorkflowViewState(makeViewInput({ toolCallId: undefined })), "missing toolCallId rejected");
  assert(!isWorkflowViewState(makeViewInput({ toolName: "plan" })), "unknown toolName rejected");
  assert(!isWorkflowViewState(makeViewInput({ name: undefined })), "missing name rejected");
  assert(!isWorkflowViewState(makeViewInput({ members: "x" })), "non-array members rejected");
  assert(!isWorkflowViewState(makeViewInput({ members: [null] })), "null member rejected");
  assert(!isWorkflowViewState(makeViewInput({ members: [{ seq: 0, label: "a", childId: "t" }] })), "non-positive member seq rejected");
  assert(!isWorkflowViewState(makeViewInput({ members: [{ seq: 1, label: "a", childId: "" }] })), "empty member childId rejected");
  assert(!isWorkflowViewState(makeViewInput({ members: [{ seq: 1, label: "a", childId: "t", outcome: "done" }] })), "illegal member outcome rejected");
  assert(!isWorkflowViewState(makeViewInput({ members: [{ seq: 1, label: "a", childId: "t", error: 5 }] })), "non-string member error rejected");
  assert(!isWorkflowViewState(makeViewInput({ logs: [{ message: 5 }] })), "non-string log message rejected");
  assert(!isWorkflowViewState(makeViewInput({ currentPhase: 5 })), "non-string currentPhase rejected");
  assert(!isWorkflowViewState(makeViewInput({ stopReason: "done" })), "illegal stopReason rejected");
  assert(!isWorkflowViewState(makeViewInput({ status: "done" })), "illegal status rejected");
  assert(!isWorkflowViewState(makeViewInput({ status: undefined })), "missing status rejected");
  assert(!isWorkflowViewState(null), "null rejected");
  assert(!isWorkflowViewState(undefined), "undefined rejected");
  assert(!isWorkflowViewState(42), "non-object rejected");
});

await run("isWorkflowToolDetails: accepts valid details", async () => {
  assert(isWorkflowToolDetails(makeDetailsInput()), "valid completed details accepted");

  const running = makeDetailsInput({
    view: makeViewInput({ status: "running", stopReason: undefined, members: [] }),
    value: null,
    agentsStarted: 0,
  });
  assert(isWorkflowToolDetails(running), "running details with null value accepted");

  const withError = makeDetailsInput({ value: null, error: "workflow run failed: x" });
  assert(isWorkflowToolDetails(withError), "details with error string accepted");
});

await run("S1: WorkflowChildStats.replayed is optional; salvage types exist; details stay old-shape", async () => {
  const withoutReplayed: WorkflowChildStats = { completed: 1, failed: 0, cancelled: 0 };
  assertEqual(withoutReplayed.replayed, undefined, "old childStats without replayed is assignable");

  const withReplayed: WorkflowChildStats = { completed: 1, failed: 0, cancelled: 0, replayed: 10 };
  assertEqual(withReplayed.replayed, 10, "replayed is accepted when present");

  const salvageChild: WorkflowSalvageChild = { seq: 1, label: "review:auth", childId: "tsk_1" };
  const salvage: WorkflowSalvage = {
    completed: [salvageChild],
    hint: "1 child results are still on disk.",
  };
  assertEqual(salvage.completed[0].childId, "tsk_1", "WorkflowSalvageChild.childId is a string");
  assertEqual(typeof salvage.hint, "string", "WorkflowSalvage.hint is a string");

  const resultWithoutSalvage: WorkflowResult = {
    value: null,
    stopReason: "error",
    error: "failed",
    agentsStarted: 1,
    childStats: withoutReplayed,
  };
  assertEqual(
    "salvage" in resultWithoutSalvage,
    false,
    "WorkflowResult does not carry salvage",
  );
  const resultWithSources: WorkflowResult = {
    value: null,
    stopReason: "completed",
    agentsStarted: 0,
    childStats: withReplayed,
    sources: [{ label: "review:auth", childId: "tsk_1" }],
  };
  assertEqual(resultWithSources.sources?.[0]?.childId, "tsk_1", "WorkflowResult.sources is optional");

  const oldDetails = makeDetailsInput();
  assert(isWorkflowToolDetails(oldDetails), "old details without replayed still pass");
  assert(
    !("salvage" in (oldDetails as Record<string, unknown>)),
    "fixture details do not include salvage",
  );

  const details: WorkflowToolDetails = {
    kind: "pix-workflow-run",
    schemaVersion: WORKFLOW_RECORD_SCHEMA_VERSION,
    view: makeViewInput() as WorkflowViewState,
    value: { ok: true },
    agentsStarted: 1,
  };
  assertEqual("salvage" in details, false, "WorkflowToolDetails does not carry salvage");
  assertEqual(details.schemaVersion, 1, "schemaVersion stays 1");

  const memberWithoutNewFields = {
    seq: 1,
    label: "a",
    childId: "t-1",
  };
  assert(
    isWorkflowViewState(makeViewInput({ members: [memberWithoutNewFields], status: "running", stopReason: undefined })),
    "isWorkflowMemberState still accepts members without new fields",
  );
});

await run("isWorkflowToolDetails: rejects malformed details", async () => {
  assert(!isWorkflowToolDetails(makeDetailsInput({ kind: "other" })), "wrong kind rejected");
  assert(!isWorkflowToolDetails(makeDetailsInput({ schemaVersion: 2 })), "wrong schemaVersion rejected");
  assert(!isWorkflowToolDetails(makeDetailsInput({ view: undefined })), "missing view rejected");
  assert(!isWorkflowToolDetails(makeDetailsInput({ view: { status: "done" } })), "invalid view rejected");
  const noValue = makeDetailsInput() as Record<string, unknown>;
  delete noValue.value;
  assert(!isWorkflowToolDetails(noValue), "missing value rejected");
  assert(!isWorkflowToolDetails(makeDetailsInput({ agentsStarted: -1 })), "negative agentsStarted rejected");
  assert(!isWorkflowToolDetails(makeDetailsInput({ agentsStarted: 1.5 })), "non-integer agentsStarted rejected");
  assert(!isWorkflowToolDetails(makeDetailsInput({ agentsStarted: NaN })), "NaN agentsStarted rejected");
  assert(!isWorkflowToolDetails(makeDetailsInput({ error: 5 })), "non-string error rejected");
  assert(!isWorkflowToolDetails(null), "null rejected");
  assert(!isWorkflowToolDetails(undefined), "undefined rejected");
});

await run("guards never access the process cwd", async () => {
  const originalCwd = process.cwd;
  process.cwd = () => {
    throw new Error("guards must not call process.cwd");
  };
  try {
    assert(isWorkflowCommand({ type: "get_snapshot" }), "isWorkflowCommand accepts valid input with cwd stubbed to throw");
    assert(isWorkflowViewState(makeViewInput()), "isWorkflowViewState accepts valid input with cwd stubbed to throw");
    assert(isWorkflowToolDetails(makeDetailsInput()), "isWorkflowToolDetails accepts valid input with cwd stubbed to throw");
    assert(fold([]).length === 0, "fold also avoids cwd with cwd stubbed to throw");
  } finally {
    process.cwd = originalCwd;
  }
  assertEqual(process.cwd(), originalCwd(), "process.cwd restored after the stubbed window");
});

// ============================================================================

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
