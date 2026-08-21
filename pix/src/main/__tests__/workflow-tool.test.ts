/**
 * Workflow tool tests (S6 + S7).
 *
 * Drives the REAL tools (createWorkflowToolDefinition and
 * createRalphToolDefinition) against a fake engine (the seam's observer bus
 * with controllable start/settle/dispose) and a fake recorder (lifecycle
 * tracking + the real foldWorkflowRecords projection, so the tool's live
 * details carry genuine views). Covers the locked tool contract: synchronous
 * start failures (SCRIPT_PARSE) and non-"completed" outcomes THROW (isError) -
 * never a partial-value success; a missing parent session throws before the
 * engine is reached; the abort bridge cancels the run once with "parent step
 * aborted"; engine events push onUpdate details with the recorder's in-memory
 * fold (value null in updates, terminal stopReason overlaid on workflow/end);
 * the completed result maps the locked content format with "Return value:" and
 * the 50_000-character truncation notice; dispose failures fall back to
 * recorder.abandon.
 *
 * The ralph sections (S7) cover the fixed script/meta/args/caps/provider
 * pass-through to the engine, the EXACT report key set
 * ("blocker,evidence,nextSteps,status,summary" with string equality after
 * trim), the maxRounds deployment ceiling rejection, round-failed as an error,
 * the never-truncated handoff, and the English terminal envelopes
 * (completion / blocker / budget-limited).
 *
 * Run with: npm exec tsx -- src/main/__tests__/workflow-tool.test.ts
 */

import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import {
  RALPH_TOOL_NAME,
  WORKFLOW_RECORD_SCHEMA_VERSION,
  WORKFLOW_TOOL_NAME,
  WorkflowRunId,
  foldWorkflowRecords,
  isWorkflowToolDetails,
} from "../../shared/workflow-types.js";
import type {
  PixWorkflowRecord,
  WorkflowMeta,
  WorkflowResult,
  WorkflowStopReason,
  WorkflowToolDetails,
  WorkflowViewState,
} from "../../shared/workflow-types.js";

/** Mirrors the unexported truncation notice in tool-workflow.ts / tool-ralph.ts. */
const TRUNCATION_NOTICE = "\n… [truncated]";
import type { AgentTaskSubmissionContext } from "../agent-task/agent-task-service.js";
import { WorkflowEngine, WorkflowError } from "../workflow/engine/engine.js";
import type { WorkflowEventListener } from "../workflow/engine/engine.js";
import type { WorkflowParentRef, WorkflowRun, WorkflowStartRequest } from "../workflow/engine/runtime-types.js";
import type { WorkflowRecorder } from "../workflow/recorder.js";
import { createRalphToolDefinition } from "../workflow/tool-ralph.js";
import type { RalphToolConfig } from "../workflow/tool-ralph.js";
import { createWorkflowToolDefinition } from "../workflow/tool-workflow.js";

// ============================================================================
// Test harness (matches plan-types.test.ts / workflow-recorder.test.ts style)
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

/** Await a promise that must reject; returns the caught value. */
async function assertRejects(promise: Promise<unknown>, message: string): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    passed++;
    console.log(`  PASS: ${message}`);
    return error;
  }
  failed++;
  console.error(`  FAIL: ${message} - promise resolved unexpectedly`);
  return undefined;
}

/** Run a function that must throw synchronously; returns the caught value. */
function assertThrowsSync(fn: () => void, message: string): unknown {
  try {
    fn();
  } catch (error) {
    passed++;
    console.log(`  PASS: ${message}`);
    return error;
  }
  failed++;
  console.error(`  FAIL: ${message} - no throw`);
  return undefined;
}

// ============================================================================
// Fixtures
// ============================================================================

const SCRIPT = "phase('scan');\nconst a = await agent('audit pkg');\nreturn { a };";
const META: WorkflowMeta = { name: "audit-all", description: "Audit packages" };

// Ralph round reports the fixed script is expected to produce (all normalized).
const RALPH_COMPLETE_REPORT = {
  status: "complete",
  summary: "audit finished",
  evidence: ["found 3 issues"],
  nextSteps: [],
  blocker: "",
};
const RALPH_CONTINUE_REPORT = {
  status: "continue",
  summary: "progressed",
  evidence: ["checked pkg-a"],
  nextSteps: ["check pkg-b"],
  blocker: "",
};
const RALPH_BLOCKED_REPORT = {
  status: "blocked",
  summary: "stuck",
  evidence: ["needs input"],
  nextSteps: [],
  blocker: "requires human credentials",
};

// ============================================================================
// Fake engine: exposes the seam's protected emit as `fire` and provides a
// controllable start / settle / dispose surface.
// ============================================================================

class FakeEngine extends WorkflowEngine {
  requests: WorkflowStartRequest[] = [];
  runs: WorkflowRun[] = [];
  cancels: string[] = [];
  disposed = 0;
  startError: Error | undefined;
  disposeError: Error | undefined;
  private nextId = 0;
  private settlements = new Map<WorkflowRunId, (result: WorkflowResult) => void>();

  start(request: WorkflowStartRequest): WorkflowRun {
    if (this.startError !== undefined) throw this.startError;
    this.requests.push(request);
    this.nextId++;
    const id = WorkflowRunId(`run-${this.nextId}`);
    let settle!: (result: WorkflowResult) => void;
    const result = new Promise<WorkflowResult>((resolve) => {
      settle = resolve;
    });
    this.settlements.set(id, settle);
    const run: WorkflowRun = {
      id,
      meta: request.meta,
      result,
      cancel: (reason?: string) => {
        this.cancels.push(reason ?? "cancelled");
        settle({
          value: null,
          stopReason: "cancelled",
          ...(reason !== undefined ? { error: reason } : {}),
          agentsStarted: 0,
        });
      },
      dispose: async () => {
        this.disposed++;
        if (this.disposeError !== undefined) throw this.disposeError;
        this.settlements.delete(id);
      },
    };
    this.runs.push(run);
    // The real engine emits workflow/start synchronously inside start().
    this.emit("workflow/start", { id, meta: request.meta });
    return run;
  }

  settle(id: WorkflowRunId, result: WorkflowResult): void {
    const resolve = this.settlements.get(id);
    if (resolve === undefined) throw new Error(`unknown run ${String(id)}`);
    resolve(result);
  }

  fire<K extends keyof WorkflowEventListener>(name: K, ...args: Parameters<WorkflowEventListener[K]>): void {
    this.emit(name, ...args);
  }

  disposeAll(): Promise<void> {
    return Promise.resolve();
  }
}

// ============================================================================
// Fake recorder: lifecycle tracking plus the REAL foldWorkflowRecords
// projection (the recorder mirrors the real one's event -> kind mapping), so
// the tool's getSnapshot() reads a genuine live fold.
// ============================================================================

class FakeRecorder implements WorkflowRecorder {
  starts: Array<{ runId: WorkflowRunId; toolCallId: string; toolName: "workflow" | "ralph"; name: string }> = [];
  finishes: Array<{ runId: WorkflowRunId; stopReason: WorkflowStopReason }> = [];
  abandons: WorkflowRunId[] = [];
  private records: PixWorkflowRecord[] = [];
  private engine: FakeEngine;

  constructor(engine: FakeEngine) {
    this.engine = engine;
  }

  start(run: { id: WorkflowRunId; meta: WorkflowMeta }, toolCallId: string, toolName: "workflow" | "ralph"): void {
    this.starts.push({ runId: run.id, toolCallId, toolName, name: run.meta.name });
    this.records.push({
      schemaVersion: WORKFLOW_RECORD_SCHEMA_VERSION,
      kind: "run-start",
      runId: run.id,
      toolCallId,
      toolName,
      name: run.meta.name,
    });
    // Mirror the real recorder's event projection so the tool's live updates
    // read a genuine fold (same algorithm as the CustomEntry path).
    this.engine.on("workflow/phase", (info, title) => {
      if (info.id !== run.id || title.length === 0) return;
      this.records.push({ schemaVersion: WORKFLOW_RECORD_SCHEMA_VERSION, kind: "phase", runId: run.id, title });
    });
    this.engine.on("workflow/log", (info, message) => {
      if (info.id !== run.id) return;
      this.records.push({ schemaVersion: WORKFLOW_RECORD_SCHEMA_VERSION, kind: "log", runId: run.id, message });
    });
    this.engine.on("workflow/agent-start", (info, agent) => {
      if (info.id !== run.id) return;
      this.records.push({
        schemaVersion: WORKFLOW_RECORD_SCHEMA_VERSION,
        kind: "agent-start",
        runId: run.id,
        seq: agent.seq,
        label: agent.label,
        childId: agent.childId,
      });
    });
    this.engine.on("workflow/agent-end", (info, agent) => {
      if (info.id !== run.id) return;
      this.records.push({
        schemaVersion: WORKFLOW_RECORD_SCHEMA_VERSION,
        kind: "agent-end",
        runId: run.id,
        seq: agent.seq,
        outcome: agent.outcome,
      });
    });
  }

  finish(runId: WorkflowRunId, stopReason: WorkflowStopReason): void {
    this.finishes.push({ runId, stopReason });
    this.records.push({ schemaVersion: WORKFLOW_RECORD_SCHEMA_VERSION, kind: "run-end", runId, stopReason });
  }

  abandon(runId: WorkflowRunId): void {
    this.abandons.push(runId);
  }

  restore(): WorkflowViewState[] {
    return [];
  }

  getSnapshot(): WorkflowViewState[] {
    return foldWorkflowRecords(this.records);
  }

  onViewChange(): () => void {
    return () => {};
  }
}

interface Harness {
  tool: ReturnType<typeof createWorkflowToolDefinition>;
  engine: FakeEngine;
  recorder: FakeRecorder;
  parentRef: WorkflowParentRef;
}

function makeHarness(options?: { getParentRef?: (toolCallId: string) => WorkflowParentRef }): Harness {
  const engine = new FakeEngine();
  const recorder = new FakeRecorder(engine);
  const parentRef: WorkflowParentRef = {
    sessionId: "session-1",
    toolCallId: "call-1",
    getSubmissionContext: () => ({}) as AgentTaskSubmissionContext,
  };
  const getParentRef = options?.getParentRef ?? (() => parentRef);
  const tool = createWorkflowToolDefinition({ engine, recorder, getParentRef });
  return { tool, engine, recorder, parentRef };
}

function executeTool(
  tool: Harness["tool"],
  params: unknown,
  signal?: AbortSignal,
  onUpdate?: AgentToolUpdateCallback<WorkflowToolDetails>,
): Promise<AgentToolResult<WorkflowToolDetails>> {
  // The 5th parameter (ExtensionContext) is only meaningful inside the agent
  // loop; the tools ignore it, so a never placeholder is used (same pattern as
  // subagent-runner.test.ts).
  return tool.execute("call-1", params as Parameters<Harness["tool"]["execute"]>[1], signal, onUpdate, undefined as never);
}

interface RalphHarness {
  tool: ReturnType<typeof createRalphToolDefinition>;
  engine: FakeEngine;
  recorder: FakeRecorder;
  parentRef: WorkflowParentRef;
}

function makeRalphHarness(config?: RalphToolConfig): RalphHarness {
  const engine = new FakeEngine();
  const recorder = new FakeRecorder(engine);
  const parentRef: WorkflowParentRef = {
    sessionId: "session-1",
    toolCallId: "call-1",
    getSubmissionContext: () => ({}) as AgentTaskSubmissionContext,
  };
  const tool = createRalphToolDefinition({ engine, recorder, getParentRef: () => parentRef }, config);
  return { tool, engine, recorder, parentRef };
}

function executeRalphTool(
  tool: RalphHarness["tool"],
  params: unknown,
  signal?: AbortSignal,
  onUpdate?: AgentToolUpdateCallback<WorkflowToolDetails>,
): Promise<AgentToolResult<WorkflowToolDetails>> {
  return tool.execute("call-1", params as Parameters<RalphHarness["tool"]["execute"]>[1], signal, onUpdate, undefined as never);
}

// ============================================================================
// Tests
// ============================================================================

await run("synchronous SCRIPT_PARSE propagates and publishes nothing", async () => {
  const h = makeHarness();
  h.engine.startError = new WorkflowError(
    "script parse failed: remove the `export const meta` statement",
    "SCRIPT_PARSE",
  );
  const error = await assertRejects(
    executeTool(h.tool, { script: "export const meta = {}", meta: META }),
    "execute rejects on a synchronous SCRIPT_PARSE",
  );
  assert(error instanceof WorkflowError, "the WorkflowError identity is preserved");
  assert((error as WorkflowError).code === "SCRIPT_PARSE", "the error code is preserved");
  assert((error as Error).message.includes("export const meta"), "the violation list reaches the model");
  assertEqual(h.engine.requests.length, 0, "start never produced a run");
  assertEqual(h.recorder.starts.length, 0, "no run record is published");
  assertEqual(h.engine.disposed, 0, "nothing to dispose");
});

await run("missing session throws before the engine is reached", async () => {
  const h = makeHarness({
    getParentRef: () => {
      throw new Error("workflow tool requires a parent session");
    },
  });
  const error = await assertRejects(executeTool(h.tool, { script: SCRIPT, meta: META }), "execute rejects without a parent session");
  assert(
    error instanceof Error && (error as Error).message === "workflow tool requires a parent session",
    "the host error propagates untouched",
  );
  assertEqual(h.engine.requests.length, 0, "the engine is never reached");
  assertEqual(h.recorder.starts.length, 0, "no run record is published");
});

await run("completed run maps content, details and lifecycle", async () => {
  const h = makeHarness();
  const updates: AgentToolResult<WorkflowToolDetails>[] = [];
  const controller = new AbortController();
  const pending = executeTool(
    h.tool,
    { script: SCRIPT, meta: META, args: { files: ["a.ts"] } },
    controller.signal,
    (update) => {
      updates.push(update);
    },
  );

  assertEqual(h.engine.requests.length, 1, "start called exactly once");
  const request = h.engine.requests[0]!;
  assertEqual(request.script, SCRIPT, "request carries the script");
  assertJson(request.meta, META, "request carries the meta");
  assertJson(request.args, { files: ["a.ts"] }, "request carries the args");
  assert(request.parent === h.parentRef, "request carries the parent ref");
  assert(request.signal === controller.signal, "request carries the abort signal");
  assert(request.subagentProvider === undefined, "the workflow tool passes no subagentProvider");
  assert(request.maxTotalAgents === undefined, "the workflow tool passes no maxTotalAgents");

  const run = h.engine.runs[0]!;
  assertEqual(h.recorder.starts.length, 1, "recorder.start called exactly once");
  assertEqual(h.recorder.starts[0]?.runId, run.id, "recorder start carries the run id");
  assertEqual(h.recorder.starts[0]?.toolCallId, "call-1", "recorder start carries the tool call id");
  assertEqual(h.recorder.starts[0]?.toolName, WORKFLOW_TOOL_NAME, "recorder start carries the tool name");

  h.engine.fire("workflow/phase", { id: run.id, meta: META }, "scan");
  h.engine.fire("workflow/agent-start", { id: run.id, meta: META }, { seq: 1, label: "audit", phase: "scan", childId: "task-1" });
  h.engine.fire("workflow/agent-end", { id: run.id, meta: META }, { seq: 1, label: "audit", phase: "scan", childId: "task-1", outcome: "completed" });
  h.engine.fire("workflow/end", { id: run.id, meta: META }, { stopReason: "completed", agentsStarted: 1 });

  assertEqual(updates.length, 4, "one update per phase/agent-start/agent-end/end event");
  assertEqual(
    (updates[0]!.content[0] as TextContent).text,
    'workflow "audit-all" phase: scan',
    "phase update is a one-line status",
  );
  assertEqual(updates[0]!.details.view.currentPhase, "scan", "phase update view carries the phase");
  assertEqual(updates[0]!.details.value, null, "updates never carry the value");
  assertEqual(updates[0]!.details.kind, "pix-workflow-run", "update details kind");
  assertEqual(updates[0]!.details.schemaVersion, WORKFLOW_RECORD_SCHEMA_VERSION, "update details schemaVersion");
  assertEqual(updates[0]!.details.agentsStarted, 0, "update agent count from the fold");

  assertEqual(
    (updates[1]!.content[0] as TextContent).text,
    'workflow "audit-all" agent 1 (audit) started',
    "agent-start update is a one-line status",
  );
  assertEqual(updates[1]!.details.view.members.length, 1, "agent-start update view lists the member");
  assertEqual(updates[1]!.details.view.members[0]?.outcome, undefined, "open member has no outcome");
  assertEqual(updates[1]!.details.agentsStarted, 1, "agent-start update counts the started agent");

  assertEqual(
    (updates[2]!.content[0] as TextContent).text,
    'workflow "audit-all" agent 1 (audit) completed',
    "agent-end update is a one-line status",
  );
  assertEqual(updates[2]!.details.view.members[0]?.outcome, "completed", "agent-end update view folds the outcome");

  assertEqual(
    (updates[3]!.content[0] as TextContent).text,
    'workflow "audit-all" finished (completed)',
    "end update is a one-line status",
  );
  assertEqual(updates[3]!.details.value, null, "the end update still carries no value");
  assertEqual(updates[3]!.details.agentsStarted, 1, "end update carries the authoritative agent count");
  assertEqual(updates[3]!.details.view.stopReason, "completed", "end update overlays the terminal stopReason");
  assertEqual(updates[3]!.details.view.status, "completed", "end update derives the terminal status");

  h.engine.settle(run.id, { value: { findings: [1, 2] }, stopReason: "completed", agentsStarted: 1 });
  const result = await pending;
  assertEqual(
    (result.content[0] as TextContent).text,
    `workflow "audit-all" completed (1 agent).\nReturn value:\n${JSON.stringify({ findings: [1, 2] }, null, 2)}`,
    "completed content matches the locked format",
  );
  assert(isWorkflowToolDetails(result.details), "details pass the shared guard");
  assertJson(result.details.value, { findings: [1, 2] }, "details carry the script value");
  assertEqual(result.details.agentsStarted, 1, "details carry the agent count");
  assertEqual(result.details.view.status, "completed", "final view is completed");
  assertEqual(result.details.view.stopReason, "completed", "final view carries the terminal stopReason");
  assertEqual(result.details.view.members.length, 1, "final view folds the member");
  assertEqual(result.details.view.members[0]?.outcome, "completed", "final view member outcome");
  assertEqual(result.details.view.currentPhase, "scan", "final view carries the phase");
  assertEqual(result.details.view.toolCallId, "call-1", "final view carries toolCallId");
  assertEqual(result.details.view.toolName, "workflow", "final view carries toolName");
  assertEqual(result.details.view.name, "audit-all", "final view carries the name");

  assertEqual(h.engine.disposed, 1, "the run is disposed exactly once");
  assertJson(h.recorder.finishes, [{ runId: run.id, stopReason: "completed" }], "recorder.finish records the terminal reason");
  assertEqual(h.recorder.abandons.length, 1, "abandon runs as the fallback after finish");
  assertEqual(h.recorder.abandons[0], run.id, "abandon targets the run");
  assertEqual(h.engine.cancels.length, 0, "no cancel on the success path");
});

await run("completed content appends child failure counts and reasons", async () => {
  const h = makeHarness();
  const pending = executeTool(h.tool, { script: SCRIPT, meta: META });
  const run = h.engine.runs[0]!;
  h.engine.settle(run.id, {
    value: [null, { ok: true }],
    stopReason: "completed",
    agentsStarted: 2,
    childStats: { completed: 1, failed: 1, cancelled: 0 },
    failures: [{ label: "audit pkg", reason: "max_turns", message: "The agent exceeded its turn limit (12)." }],
  });
  const result = await pending;
  const text = (result.content[0] as TextContent).text;
  assert(text.includes("2 agents, 1 ok / 1 failed"), "parent text carries ok/failed counts");
  assert(text.includes("Failures:"), "parent text has a Failures section");
  assert(text.includes("audit pkg: max_turns: The agent exceeded its turn limit (12)."), "parent text names the failed item");
  assert(text.includes("Return value:"), "parent text still carries the script value");
});

await run("non-completed stop reasons throw mapped messages, never partial success", async () => {
  const h = makeHarness();
  let pending = executeTool(h.tool, { script: SCRIPT, meta: META });
  const run = h.engine.runs[0]!;
  // A cancelled run with a partial value is still a failure.
  h.engine.settle(run.id, { value: { partial: true }, stopReason: "cancelled", error: "parent step aborted", agentsStarted: 0 });
  const cancelError = await assertRejects(pending, "cancelled run rejects");
  assert(
    cancelError instanceof Error && (cancelError as Error).message === "workflow run was cancelled (parent step aborted)",
    "cancelled message maps the reason",
  );
  assertJson(h.recorder.finishes, [{ runId: run.id, stopReason: "cancelled" }], "finish records cancelled");
  assertEqual(h.engine.disposed, 1, "dispose ran on the cancelled path");

  // An error run with a partial value is still a failure.
  let pending2 = executeTool(h.tool, { script: SCRIPT, meta: META });
  const run2 = h.engine.runs[1]!;
  h.engine.settle(run2.id, { value: { partial: true }, stopReason: "error", error: "AGENT_START: agent failed to start", agentsStarted: 0 });
  const errorError = await assertRejects(pending2, "error run rejects");
  assert(
    errorError instanceof Error && (errorError as Error).message === "workflow run failed: AGENT_START: agent failed to start",
    "error message maps the reason",
  );
  assertJson(h.recorder.finishes.at(-1), { runId: run2.id, stopReason: "error" }, "finish records error");

  // An error without a message falls back to the generic text.
  let pending3 = executeTool(h.tool, { script: SCRIPT, meta: META });
  const run3 = h.engine.runs[2]!;
  h.engine.settle(run3.id, { value: null, stopReason: "error", agentsStarted: 0 });
  const bareError = await assertRejects(pending3, "bare error run rejects");
  assert(
    bareError instanceof Error && (bareError as Error).message === "workflow run failed: unknown error",
    "bare error falls back to unknown error",
  );
});

await run("abort signal cancels the run once with parent step aborted", async () => {
  const h = makeHarness();
  const controller = new AbortController();
  const pending = executeTool(h.tool, { script: SCRIPT, meta: META }, controller.signal);
  const run = h.engine.runs[0]!;
  controller.abort();
  assertJson(h.engine.cancels, ["parent step aborted"], "the abort bridge cancels with the locked reason, exactly once");
  const error = await assertRejects(pending, "aborted run rejects");
  assert(
    error instanceof Error && (error as Error).message === "workflow run was cancelled (parent step aborted)",
    "the run reports the parent-step-aborted reason",
  );
  assertJson(h.recorder.finishes, [{ runId: run.id, stopReason: "cancelled" }], "finish records cancelled");
});

await run("values beyond 50_000 characters are truncated with a notice", async () => {
  const h = makeHarness();
  const pending = executeTool(h.tool, { script: SCRIPT, meta: META });
  const run = h.engine.runs[0]!;
  const value = { findings: "x".repeat(60_000) };
  h.engine.settle(run.id, { value, stopReason: "completed", agentsStarted: 2 });
  const result = await pending;
  const maxChars = 50_000;
  const fullText = `workflow "audit-all" completed (2 agents).\nReturn value:\n${JSON.stringify(value, null, 2)}`;
  // The WHOLE parent-facing text (envelope included) is bounded to maxChars,
  // mirroring ralph's boundResult semantics.
  const expected = `${fullText.slice(0, maxChars - TRUNCATION_NOTICE.length)}${TRUNCATION_NOTICE}`;
  assert((expected.length <= maxChars), "truncated content stays within the budget");
  assertEqual((result.content[0] as TextContent).text, expected, "content truncates past 50_000 characters with the notice");
  assertJson(result.details.value, value, "details keep the untruncated value");
});

await run("dispose failure falls back to recorder.abandon", async () => {
  const h = makeHarness();
  h.engine.disposeError = new Error("dispose boom");
  const pending = executeTool(h.tool, { script: SCRIPT, meta: META });
  const run = h.engine.runs[0]!;
  h.engine.settle(run.id, { value: { ok: true }, stopReason: "completed", agentsStarted: 0 });
  const error = await assertRejects(pending, "a dispose failure rejects the tool call");
  assert(error instanceof Error && (error as Error).message === "dispose boom", "the dispose error surfaces");
  assertEqual(h.recorder.finishes.length, 0, "finish is skipped when dispose throws");
  assertEqual(h.recorder.abandons.length, 1, "abandon runs as the fallback");
  assertEqual(h.recorder.abandons[0], run.id, "abandon targets the run");
});

// ============================================================================
// Ralph (S7)
// ============================================================================

await run("ralph: fixed script, meta, caps and provider reach the engine; completed maps content", async () => {
  const h = makeRalphHarness();
  const updates: AgentToolResult<WorkflowToolDetails>[] = [];
  const pending = executeRalphTool(h.tool, { objective: "audit the tree" }, undefined, (update) => {
    updates.push(update);
  });

  assertEqual(h.engine.requests.length, 1, "start called exactly once");
  const request = h.engine.requests[0]!;
  assert(request.script.includes("reportSchema"), "request carries the fixed ralph script");
  assert(request.script.includes("args.maxRounds"), "the script reads the round cap from args");
  assertJson(
    request.meta,
    {
      name: "ralph-loop",
      description: "Iterate toward one objective with a fresh child and bounded structured handoff per round.",
      phases: [{ title: "Fresh-agent rounds", detail: "One clean child context per Ralph round." }],
    },
    "request carries the fixed meta",
  );
  assertJson(
    request.args,
    { objective: "audit the tree", maxRounds: 64, maxHandoffChars: 16384 },
    "request args carry the objective and the default caps",
  );
  assertEqual(request.maxTotalAgents, 64, "maxTotalAgents equals the default maxRounds");
  assertEqual(request.subagentProvider, "general-purpose", "the default provider is general-purpose");
  assert(request.parent === h.parentRef, "request carries the parent ref");

  const run = h.engine.runs[0]!;
  assertEqual(h.recorder.starts.length, 1, "recorder.start called exactly once");
  assertEqual(h.recorder.starts[0]?.toolName, RALPH_TOOL_NAME, "recorder start carries the ralph tool name");

  h.engine.fire("workflow/phase", { id: run.id, meta: run.meta }, "Fresh-agent rounds");
  h.engine.fire(
    "workflow/agent-start",
    { id: run.id, meta: run.meta },
    { seq: 1, label: "Ralph round 1", phase: "Fresh-agent rounds", childId: "task-1" },
  );
  h.engine.fire(
    "workflow/agent-end",
    { id: run.id, meta: run.meta },
    { seq: 1, label: "Ralph round 1", phase: "Fresh-agent rounds", childId: "task-1", outcome: "completed" },
  );
  h.engine.fire("workflow/end", { id: run.id, meta: run.meta }, { stopReason: "completed", agentsStarted: 1 });

  assertEqual(updates.length, 4, "one update per phase/agent-start/agent-end/end event");
  assertEqual(
    (updates[0]!.content[0] as TextContent).text,
    'ralph "ralph-loop" phase: Fresh-agent rounds',
    "phase update is a one-line status",
  );
  assertEqual(updates[0]!.details.view.currentPhase, "Fresh-agent rounds", "phase update view carries the phase");
  assertEqual(updates[0]!.details.value, null, "updates never carry the value");
  assertEqual(
    (updates[3]!.content[0] as TextContent).text,
    'ralph "ralph-loop" finished (completed)',
    "end update is a one-line status",
  );
  assertEqual(updates[3]!.details.view.stopReason, "completed", "end update overlays the terminal stopReason");
  assertEqual(updates[3]!.details.view.status, "completed", "end update derives the terminal status");

  const value = { status: "complete", roundsStarted: 1, report: RALPH_COMPLETE_REPORT };
  h.engine.settle(run.id, { value, stopReason: "completed", agentsStarted: 1 });
  const result = await pending;
  assertEqual(
    (result.content[0] as TextContent).text,
    `Ralph worker reported completion after 1 round.\nFinal report:\n${JSON.stringify(RALPH_COMPLETE_REPORT, null, 2)}`,
    "completed content matches the locked envelope",
  );
  assert(isWorkflowToolDetails(result.details), "details pass the shared guard");
  assertJson(result.details.value, value, "details carry the decoded run value");
  assertEqual(result.details.agentsStarted, 1, "details carry the agent count");
  assertEqual(result.details.view.status, "completed", "final view is completed");
  assertEqual(result.details.view.toolName, "ralph", "final view carries toolName");
  assertEqual(result.details.view.name, "ralph-loop", "final view carries the name");
  assertEqual(result.details.view.members.length, 1, "final view folds the member");
  assertEqual(result.details.view.members[0]?.outcome, "completed", "final view member outcome");

  assertEqual(h.engine.disposed, 1, "the run is disposed exactly once");
  assertJson(h.recorder.finishes, [{ runId: run.id, stopReason: "completed" }], "recorder.finish records completed");
  assertEqual(h.recorder.abandons.length, 1, "abandon runs as the fallback after finish");
  assertEqual(h.engine.cancels.length, 0, "no cancel on the success path");
});

await run("ralph: configured provider and model-selected cap pass through to the engine", async () => {
  const h = makeRalphHarness({ subagentProvider: "auditor", maxRounds: 8 });
  const pending = executeRalphTool(h.tool, { objective: "audit", maxRounds: 3 });
  const request = h.engine.requests[0]!;
  assertEqual(request.subagentProvider, "auditor", "the configured provider reaches the engine");
  assertEqual(request.maxTotalAgents, 3, "the model-selected cap bounds maxTotalAgents");
  assertJson(
    request.args,
    { objective: "audit", maxRounds: 3, maxHandoffChars: 16384 },
    "args carry the model-selected cap",
  );
  h.engine.settle(h.engine.runs[0]!.id, {
    value: { status: "complete", roundsStarted: 3, report: RALPH_COMPLETE_REPORT },
    stopReason: "completed",
    agentsStarted: 3,
  });
  const result = await pending;
  assertEqual(result.details.agentsStarted, 3, "the completed result carries the agent count");
});

await run("ralph: maxRounds above the deployment ceiling rejects before start", async () => {
  const h = makeRalphHarness({ maxRounds: 2 });
  const error = await assertRejects(
    executeRalphTool(h.tool, { objective: "audit", maxRounds: 5 }),
    "an oversized maxRounds request rejects",
  );
  assert(
    error instanceof Error && (error as Error).message === "Ralph maxRounds 5 exceeds the deployment ceiling 2",
    "the ceiling violation message is explicit",
  );
  assertEqual(h.engine.requests.length, 0, "the engine is never reached");
  assertEqual(h.recorder.starts.length, 0, "no run record is published");
  assertEqual(h.engine.disposed, 0, "nothing to dispose");

  const nonPositive = await assertRejects(
    executeRalphTool(h.tool, { objective: "audit", maxRounds: 0 }),
    "a non-positive maxRounds request rejects",
  );
  assert(
    nonPositive instanceof Error && (nonPositive as Error).message === "Ralph maxRounds must be a positive safe integer",
    "non-positive caps are rejected",
  );
  assertEqual(h.engine.requests.length, 0, "still no engine request");
});

await run("ralph: invalid tool config throws at creation", async () => {
  const badMaxRounds = assertThrowsSync(
    () => makeRalphHarness({ maxRounds: 0 }),
    "a non-positive maxRounds config throws at creation",
  );
  assert(
    badMaxRounds instanceof TypeError && (badMaxRounds as Error).message === "maxRounds must be a positive safe integer",
    "the config violation message is explicit",
  );
  const badHandoff = assertThrowsSync(
    () => makeRalphHarness({ maxHandoffChars: 1.5 }),
    "a fractional maxHandoffChars config throws at creation",
  );
  assert(
    badHandoff instanceof TypeError && (badHandoff as Error).message === "maxHandoffChars must be a positive safe integer",
    "fractional handoff caps are rejected",
  );
  const badProvider = assertThrowsSync(
    () => makeRalphHarness({ subagentProvider: " x " }),
    "an unnormalized subagentProvider config throws at creation",
  );
  assert(
    badProvider instanceof TypeError
      && (badProvider as Error).message === "subagentProvider must be a non-empty normalized string",
    "unnormalized providers are rejected",
  );
});

await run("ralph: an illegal report key set fails", async () => {
  const h = makeRalphHarness();
  // An extra key on the report breaks the EXACT key set
  // "blocker,evidence,nextSteps,status,summary".
  let pending = executeRalphTool(h.tool, { objective: "audit" });
  const run = h.engine.runs[0]!;
  h.engine.settle(run.id, {
    value: { status: "complete", roundsStarted: 1, report: { ...RALPH_COMPLETE_REPORT, extra: "x" } },
    stopReason: "completed",
    agentsStarted: 1,
  });
  const extraKeyError = await assertRejects(pending, "a report with an extra key rejects");
  assert(
    extraKeyError instanceof Error && (extraKeyError as Error).message === "Ralph workflow returned a malformed round report",
    "the malformed-report message is explicit",
  );
  assertEqual(h.engine.disposed, 1, "dispose still ran on the failure path");
  assertJson(h.recorder.finishes, [{ runId: run.id, stopReason: "completed" }], "finish records the run's actual stop reason");

  // A missing key breaks the key set too.
  let pending2 = executeRalphTool(h.tool, { objective: "audit" });
  const run2 = h.engine.runs[1]!;
  const missingKey: Record<string, unknown> = { ...RALPH_COMPLETE_REPORT };
  delete missingKey["blocker"];
  h.engine.settle(run2.id, {
    value: { status: "complete", roundsStarted: 1, report: missingKey },
    stopReason: "completed",
    agentsStarted: 1,
  });
  const missingKeyError = await assertRejects(pending2, "a report with a missing key rejects");
  assert(
    missingKeyError instanceof Error && (missingKeyError as Error).message === "Ralph workflow returned a malformed round report",
    "missing-key report message",
  );

  // A report whose status does not match the terminal status rejects.
  let pending3 = executeRalphTool(h.tool, { objective: "audit" });
  const run3 = h.engine.runs[2]!;
  h.engine.settle(run3.id, {
    value: { status: "complete", roundsStarted: 1, report: RALPH_CONTINUE_REPORT },
    stopReason: "completed",
    agentsStarted: 1,
  });
  const statusError = await assertRejects(pending3, "a report with a mismatched status rejects");
  assert(
    statusError instanceof Error && (statusError as Error).message === "Ralph workflow returned a malformed round report",
    "mismatched-status report message",
  );

  // A completion report with nextSteps violates the completion contract.
  let pending4 = executeRalphTool(h.tool, { objective: "audit" });
  const run4 = h.engine.runs[3]!;
  h.engine.settle(run4.id, {
    value: { status: "complete", roundsStarted: 1, report: { ...RALPH_COMPLETE_REPORT, nextSteps: ["more"] } },
    stopReason: "completed",
    agentsStarted: 1,
  });
  const invalidCompleteError = await assertRejects(pending4, "a completion report with nextSteps rejects");
  assert(
    invalidCompleteError instanceof Error
      && (invalidCompleteError as Error).message === "Ralph workflow returned an invalid completion report",
    "invalid completion report message",
  );
});

await run("ralph: round-failed throws with the last handoff", async () => {
  const h = makeRalphHarness();
  // A first-round failure carries no last handoff.
  let pending = executeRalphTool(h.tool, { objective: "audit" });
  const run = h.engine.runs[0]!;
  h.engine.settle(run.id, {
    value: { status: "round-failed", roundsStarted: 1, lastReport: null },
    stopReason: "completed",
    agentsStarted: 1,
  });
  const firstRoundError = await assertRejects(pending, "a first-round failure rejects");
  assert(
    firstRoundError instanceof Error
      && (firstRoundError as Error).message
        === "Ralph round 1 child failed before producing a structured report.\nNo previous handoff was available.",
    "first-round failure renders no previous handoff",
  );

  // Later rounds carry the last successful handoff.
  let pending2 = executeRalphTool(h.tool, { objective: "audit" });
  const run2 = h.engine.runs[1]!;
  h.engine.settle(run2.id, {
    value: { status: "round-failed", roundsStarted: 2, lastReport: RALPH_CONTINUE_REPORT },
    stopReason: "completed",
    agentsStarted: 2,
  });
  const laterError = await assertRejects(pending2, "a later-round failure rejects");
  assert(
    laterError instanceof Error
      && (laterError as Error).message
        === `Ralph round 2 child failed before producing a structured report.\nLast successful handoff:\n${JSON.stringify(RALPH_CONTINUE_REPORT, null, 2)}`,
    "later-round failure renders the last successful handoff",
  );

  // A round failure with a non-null first-round lastReport is itself invalid.
  let pending3 = executeRalphTool(h.tool, { objective: "audit" });
  const run3 = h.engine.runs[2]!;
  h.engine.settle(run3.id, {
    value: { status: "round-failed", roundsStarted: 1, lastReport: RALPH_CONTINUE_REPORT },
    stopReason: "completed",
    agentsStarted: 1,
  });
  const invalidError = await assertRejects(pending3, "an invalid first-round failure rejects");
  assert(
    invalidError instanceof Error && (invalidError as Error).message === "Ralph workflow returned an invalid first-round failure",
    "invalid first-round failure message",
  );
});

await run("ralph: blocked and budget-limited map their envelopes", async () => {
  // blocked
  const h = makeRalphHarness();
  let pending = executeRalphTool(h.tool, { objective: "audit" });
  const run = h.engine.runs[0]!;
  h.engine.settle(run.id, {
    value: { status: "blocked", roundsStarted: 1, report: RALPH_BLOCKED_REPORT },
    stopReason: "completed",
    agentsStarted: 1,
  });
  const blockedResult = await pending;
  assertEqual(
    (blockedResult.content[0] as TextContent).text,
    `Ralph worker reported a blocker after 1 round.\nFinal report:\n${JSON.stringify(RALPH_BLOCKED_REPORT, null, 2)}`,
    "blocked content matches the locked envelope",
  );

  // budget-limited exactly at the round limit
  const h2 = makeRalphHarness({ maxRounds: 2 });
  let pending2 = executeRalphTool(h2.tool, { objective: "audit", maxRounds: 2 });
  const run2 = h2.engine.runs[0]!;
  assertEqual(h2.engine.requests[0]!.maxTotalAgents, 2, "maxTotalAgents equals the capped maxRounds");
  h2.engine.settle(run2.id, {
    value: { status: "budget-limited", roundsStarted: 2, report: RALPH_CONTINUE_REPORT },
    stopReason: "completed",
    agentsStarted: 2,
  });
  const limitedResult = await pending2;
  assertEqual(
    (limitedResult.content[0] as TextContent).text,
    `Ralph reached its 2 rounds limit; the worker reported work remaining.\nFinal report:\n${JSON.stringify(RALPH_CONTINUE_REPORT, null, 2)}`,
    "budget-limited content matches the locked envelope",
  );

  // budget-limited before the limit is invalid
  let pending3 = executeRalphTool(h2.tool, { objective: "audit", maxRounds: 2 });
  const run3 = h2.engine.runs[1]!;
  h2.engine.settle(run3.id, {
    value: { status: "budget-limited", roundsStarted: 1, report: RALPH_CONTINUE_REPORT },
    stopReason: "completed",
    agentsStarted: 1,
  });
  const earlyError = await assertRejects(pending3, "budget-limited before the limit rejects");
  assert(
    earlyError instanceof Error
      && (earlyError as Error).message === "Ralph workflow returned budget-limited before the round limit",
    "early budget-limited message",
  );
});

await run("ralph: non-completed stop reasons throw mapped messages", async () => {
  const h = makeRalphHarness();
  let pending = executeRalphTool(h.tool, { objective: "audit" });
  const run = h.engine.runs[0]!;
  h.engine.settle(run.id, { value: null, stopReason: "cancelled", error: "parent step aborted", agentsStarted: 0 });
  const cancelError = await assertRejects(pending, "a cancelled run rejects");
  assert(
    cancelError instanceof Error && (cancelError as Error).message === "Ralph workflow was cancelled (parent step aborted)",
    "cancelled message maps the reason",
  );
  assertJson(h.recorder.finishes, [{ runId: run.id, stopReason: "cancelled" }], "finish records cancelled");

  let pending2 = executeRalphTool(h.tool, { objective: "audit" });
  const run2 = h.engine.runs[1]!;
  h.engine.settle(run2.id, { value: null, stopReason: "error", error: "AGENT_START: agent failed to start", agentsStarted: 0 });
  const errorError = await assertRejects(pending2, "an error run rejects");
  assert(
    errorError instanceof Error && (errorError as Error).message === "Ralph workflow failed: AGENT_START: agent failed to start",
    "error message maps the reason",
  );
  assertEqual(h.engine.disposed, 2, "both runs were disposed");
});

await run("ralph: an empty objective rejects before the engine", async () => {
  const h = makeRalphHarness();
  const error = await assertRejects(
    executeRalphTool(h.tool, { objective: "   " }),
    "a whitespace-only objective rejects",
  );
  assert(
    error instanceof Error && (error as Error).message === "Ralph objective must be a non-empty string",
    "the objective message is explicit",
  );
  assertEqual(h.engine.requests.length, 0, "the engine is never reached");
  assertEqual(h.recorder.starts.length, 0, "no run record is published");
});

await run("ralph: abort signal cancels the run once with parent step aborted", async () => {
  const h = makeRalphHarness();
  const controller = new AbortController();
  const pending = executeRalphTool(h.tool, { objective: "audit" }, controller.signal);
  const run = h.engine.runs[0]!;
  controller.abort();
  assertJson(h.engine.cancels, ["parent step aborted"], "the abort bridge cancels with the locked reason, exactly once");
  const error = await assertRejects(pending, "an aborted run rejects");
  assert(
    error instanceof Error && (error as Error).message === "Ralph workflow was cancelled (parent step aborted)",
    "the run reports the parent-step-aborted reason",
  );
});

await run("ralph: missing session throws before the engine is reached", async () => {
  const engine = new FakeEngine();
  const recorder = new FakeRecorder(engine);
  const tool = createRalphToolDefinition({
    engine,
    recorder,
    getParentRef: () => {
      throw new Error("ralph tool requires a parent session");
    },
  });
  const error = await assertRejects(
    executeRalphTool(tool, { objective: "audit" }),
    "execute rejects without a parent session",
  );
  assert(
    error instanceof Error && (error as Error).message === "ralph tool requires a parent session",
    "the host error propagates untouched",
  );
  assertEqual(engine.requests.length, 0, "the engine is never reached");
  assertEqual(recorder.starts.length, 0, "no run record is published");
});

await run("ralph: oversized parent-facing text is truncated; the handoff itself is never truncated", async () => {
  // maxResultChars bounds the parent-facing envelope (with a notice).
  const h = makeRalphHarness({ maxResultChars: 120 });
  let pending = executeRalphTool(h.tool, { objective: "audit" });
  const run = h.engine.runs[0]!;
  const longReport = { status: "complete", summary: "s".repeat(200), evidence: ["e"], nextSteps: [], blocker: "" };
  h.engine.settle(run.id, {
    value: { status: "complete", roundsStarted: 1, report: longReport },
    stopReason: "completed",
    agentsStarted: 1,
  });
  const result = await pending;
  const text = (result.content[0] as TextContent).text;
  assert(text.length <= 120, "envelope text is bounded by maxResultChars");
  assert(text.endsWith("\n… [truncated]"), "truncated text carries the notice");

  // The handoff itself is never silently truncated: an oversized report
  // rejects.
  const h2 = makeRalphHarness({ maxHandoffChars: 32 });
  let pending2 = executeRalphTool(h2.tool, { objective: "audit" });
  const run2 = h2.engine.runs[0]!;
  h2.engine.settle(run2.id, {
    value: { status: "complete", roundsStarted: 1, report: longReport },
    stopReason: "completed",
    agentsStarted: 1,
  });
  const oversizedError = await assertRejects(pending2, "an oversized handoff rejects");
  assert(
    oversizedError instanceof Error
      && (oversizedError as Error).message.startsWith("Ralph workflow returned an oversized handoff"),
    "the oversized handoff message is explicit",
  );
});

// ============================================================================

await run("summary", async () => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
});
