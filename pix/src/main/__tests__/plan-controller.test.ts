/**
 * PlanController state-machine tests (PiX 1.4.0, P1).
 *
 * Drives the REAL PlanController against a duck-typed AgentSession /
 * SessionManager harness: first visible user turn with requestText and no
 * duplicate prompt, generation failure three-ops (retry / use-session-model /
 * cancel), concise regeneration, revision failure fallback, approved ->
 * executing, read-only gates, DAG/path validation, reload gate, parent
 * request_user_input waiting, unified completed gate, completion criteria,
 * cancel / dispose / dormant hydration (incl. the 1.4.0 A8 executing
 * hydration), fork lineage isolation, deviations, tool policy and §6.3
 * product events.
 *
 * Run with: npm exec tsx -- src/main/__tests__/plan-controller.test.ts
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  AgentExecutionMode,
  AgentSession,
  AgentSessionEvent,
  HostToolPolicyInput,
  SessionEntry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ProjectLocation, ThinkingLevel } from "../../shared/types.js";
import type { ProductEvent } from "../../shared/product-events.js";
import { PLAN_ALLOWLIST, PLAN_SCHEMA_VERSION, type PlanDeviation, type PlanStep } from "../../shared/plan-types.js";
import type { ProjectExecutionContext } from "../execution-context.js";
import { PlanController } from "../plan/plan-controller.js";
import type {
  PlanControllerContext,
  PlanLinkedTaskFileChangeEvent,
  PlanStepExecutionLink,
  StepDelegateResult,
} from "../plan/plan-controller.js";
import type { SubmitUserPlanParams } from "../plan/plan-deviation.js";
import { rebuildPlanFromEntries, serializePlanRecord } from "../plan/plan-persistence.js";

// ============================================================================
// Test harness (matches plan-types.test.ts / session-bridge-subagent.test.ts)
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

function assertIncludes<T>(actual: readonly T[], expected: T, message: string): void {
  if (actual.includes(expected)) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    console.error(`  FAIL: ${message} - expected ${JSON.stringify(expected)} in ${JSON.stringify(actual)}`);
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

function drain(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(condition: () => boolean, iterations = 20000, message = "condition"): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    if (condition()) {
      return;
    }
    await drain();
  }
  throw new Error(`Timed out waiting for ${message}`);
}

// ============================================================================
// Shared temp workspace
// ============================================================================

const WORKSPACE = mkdtempSync(join(tmpdir(), "pix-plan-ws-"));
mkdirSync(join(WORKSPACE, "src"), { recursive: true });
writeFileSync(join(WORKSPACE, "src", "a.txt"), "hello", "utf-8");

function makeLocation(): ProjectLocation {
  return {
    path: WORKSPACE,
    physicalPath: WORKSPACE,
    name: "plan-ws",
    environment: { kind: "windows" },
  };
}

function makeExecutionContext(): ProjectExecutionContext {
  return {
    location: makeLocation(),
    logicalCwd: WORKSPACE,
    physicalCwd: WORKSPACE,
    isWsl: false,
  };
}

function makeModel(provider = "faux", id = "faux-model"): Model<Api> {
  return {
    id,
    name: id,
    api: "faux-api",
    provider,
    baseUrl: "http://localhost:1",
    reasoning: true,
    thinkingLevelMap: { off: null, low: "low", high: "high" },
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100000,
    maxTokens: 4096,
  } as unknown as Model<Api>;
}

// ============================================================================
// Fake session / manager
// ============================================================================

interface CustomMessageRecord {
  customType: string;
  content: string;
  context?: "internal";
  triggerTurn?: boolean;
}

class FakeSession {
  isStreaming = false;
  model: Model<Api> | undefined = makeModel();
  thinkingLevel: ThinkingLevel = "off";
  activeTools: string[] = ["read", "bash", "edit", "write", "grep", "find", "ls", "agent", "request_user_input"];
  modelCalls: Array<{ provider: string; id: string }> = [];
  customMessages: CustomMessageRecord[] = [];
  abortCalls = 0;
  private _listener: ((event: unknown) => void) | undefined;

  subscribe(listener: (event: unknown) => void): () => void {
    this._listener = listener;
    return () => {
      this._listener = undefined;
    };
  }

  getActiveToolNames(): string[] {
    return [...this.activeTools];
  }

  setActiveToolsByName(toolNames: string[]): void {
    this.activeTools = [...toolNames];
  }

  async setModel(model: Model<Api>): Promise<void> {
    this.model = model;
    this.modelCalls.push({ provider: model.provider, id: model.id });
  }

  setThinkingLevel(level: ThinkingLevel): void {
    this.thinkingLevel = level;
  }

  async abort(): Promise<void> {
    this.abortCalls += 1;
  }

  async sendCustomMessage(
    message: { customType: string; content: string; display: boolean; context?: "internal" },
    options?: { triggerTurn?: boolean },
  ): Promise<void> {
    this.customMessages.push({
      customType: message.customType,
      content: typeof message.content === "string" ? message.content : "",
      context: message.context,
      triggerTurn: options?.triggerTurn,
    });
  }

  emit(event: unknown): void {
    this._listener?.(event);
  }

  emitTurnSettled(stopReason = "stop"): void {
    this.emit({ type: "message_end", message: { role: "assistant", content: [], stopReason } });
    this.emit({ type: "agent_end", messages: [] });
  }
}

class FakeSessionManager {
  entries: SessionEntry[] = [];

  appendCustomEntry(customType: string, data?: unknown): string {
    const id = `plan-entry-${this.entries.length + 1}`;
    this.entries.push({
      type: "custom",
      id,
      parentId: null,
      timestamp: new Date().toISOString(),
      customType,
      data,
    } as SessionEntry);
    return id;
  }

  getEntries(): SessionEntry[] {
    return [...this.entries];
  }
}

interface TaskGroupResult {
  status: "completed" | "failed" | "cancelled";
  summary: string;
}

interface Harness {
  session: FakeSession;
  manager: FakeSessionManager;
  executionMode: AgentExecutionMode;
  promptCalls: Array<{ text: string; filePaths?: string[] }>;
  productEvents: ProductEvent[];
  delegated: Array<{ step: PlanStep; link: PlanStepExecutionLink; presentation: string }>;
  delegateResult: StepDelegateResult | undefined;
  /** 1.4.1: groupId -> terminal group result (getPlanTaskGroupResult). */
  taskGroupResults: Map<string, TaskGroupResult>;
  /** 1.4.1: recorded consumption confirms (groupId -> count). */
  confirmCalls: Array<{ groupId: string; link: PlanStepExecutionLink }>;
  /** 1.4.1: recorded releases. */
  releaseCalls: Array<{ groupId: string; link: PlanStepExecutionLink; reason: "plan_revised" | "plan_cancelled" }>;
  /** 1.4.1: optional subscriber for Plan-linked task file changes. */
  linkedTaskListener: ((event: PlanLinkedTaskFileChangeEvent) => void) | undefined;
  /** Optional resolvePlanningModel override: a model different from the session model (planModel setting). */
  planningModel?: { model: Model<Api>; thinkingLevel: ThinkingLevel };
}

function makeHarness(overrides: Partial<Harness> = {}): Harness {
  const harness: Harness = {
    session: new FakeSession(),
    manager: new FakeSessionManager(),
    executionMode: "approval",
    promptCalls: [],
    productEvents: [],
    delegated: [],
    delegateResult: undefined,
    taskGroupResults: new Map(),
    confirmCalls: [],
    releaseCalls: [],
    linkedTaskListener: undefined,
    ...overrides,
  };
  return harness;
}

function makeContext(h: Harness): PlanControllerContext {
  return {
    getSession: () => h.session as AgentSession,
    getSessionManager: () => h.manager as SessionManager,
    getProjectLocation: () => makeLocation(),
    getExecutionContext: () => makeExecutionContext(),
    getExecutionMode: () => h.executionMode,
    resolvePlanningModel: () => h.planningModel ?? { model: makeModel(), thinkingLevel: "high" },
    promptPlanningRequest: async (request) => {
      h.promptCalls.push({ text: request.text, filePaths: request.filePaths });
    },
    requestUserInput: async () => ({ id: "req", cancelled: true, answers: {} }),
    recordProductEvent: (e) => {
      h.productEvents.push(e);
    },
    delegateSubagentStep: async (step, link, presentation) => {
      h.delegated.push({ step, link, presentation });
      return h.delegateResult ?? { stepId: step.stepId, status: "result", summary: "subagent done" };
    },
    subscribePlanLinkedTaskEvents: (listener) => {
      h.linkedTaskListener = listener;
      return () => {
        h.linkedTaskListener = undefined;
      };
    },
    getPlanTaskGroupResult: async (groupId, link) => {
      const result = h.taskGroupResults.get(groupId);
      if (!result) {
        return { ok: false, reason: "group_not_terminal" };
      }
      return { ok: true, status: result.status, taskIds: [`task-${groupId}`], summary: result.summary };
    },
    confirmPlanTaskGroupConsumed: async (groupId, link) => {
      h.confirmCalls.push({ groupId, link });
    },
    releasePlanTaskGroup: async (groupId, link, reason) => {
      h.releaseCalls.push({ groupId, link, reason });
    },
  };
}

function makeController(h: Harness, opts?: { generationTimeoutMs?: number; abortSettleMs?: number }): PlanController {
  return new PlanController(makeContext(h), { abortSettleMs: 20, ...opts });
}

// ============================================================================
// Draft helpers
// ============================================================================

function makeDraft(): SubmitUserPlanParams {
  return {
    generationId: "unused",
    title: "Refactor the widget",
    summary: "Restructure the widget module and add tests.",
    steps: [
      {
        stepKey: "s0",
        title: "Inspect current widget",
        description: "Read the current widget implementation and identify the refactor seams.",
        files: [{ path: "src/a.txt", operation: "read" }],
        expectedCommands: ["npm test"],
        executionTarget: "parent",
        risk: "low",
        riskReason: "Read-only inspection.",
        effort: "small",
        verification: "The seams are documented.",
        dependsOn: [],
      },
      {
        stepKey: "s1",
        title: "Implement the refactor",
        description: "Apply the refactor to the widget module.",
        files: [{ path: "src/", operation: "modify" }],
        scopeNote: "Only src/ may change.",
        expectedCommands: ["npm test"],
        executionTarget: "parent",
        risk: "medium",
        riskReason: "Modifies source files.",
        effort: "medium",
        verification: "npm test passes.",
        dependsOn: ["s0"],
      },
    ],
  };
}

/** Enter -> submit -> approve -> startExecution with a parent step running. */
async function driveToExecuting(c: PlanController, h: Harness, draft: SubmitUserPlanParams = makeDraft()): Promise<{ planId: string; version: number; step0: PlanStep; step1: PlanStep }> {
  const entered = await c.enterPlanning({ text: "plan this work" });
  assert(entered.ok, "enterPlanning ok");
  const genId = entered.generationId!;
  const submitted = await c.submitPlan({ ...draft, generationId: genId });
  assert(submitted.accepted, "draft accepted");
  const snapshot = c.getSnapshot();
  const planId = snapshot.planId!;
  const version = snapshot.plan!.version;
  const step0 = snapshot.plan!.steps[0];
  const step1 = snapshot.plan!.steps[1];
  const approved = await c.approve(planId, version);
  assert(approved.ok, "approve ok");
  const started = await c.startExecution(planId, version);
  assert(started.ok, "startExecution ok");
  return { planId, version, step0, step1 };
}

const eventNames = (h: Harness): string[] => h.productEvents.map((e) => e.name);

// ============================================================================
// Tests
// ============================================================================

await run("enterPlanning: one visible user turn with requestText, never duplicated", async () => {
  const h = makeHarness();
  const c = makeController(h);
  const result = await c.enterPlanning({ text: "build me a plan", filePaths: [join(WORKSPACE, "src", "a.txt")] });
  assert(result.ok, "enterPlanning ok");
  const s = c.getSnapshot();
  assertEqual(s.phase, "planning", "snapshot phase planning");
  assert(s.planId !== null, "planId assigned on first enter");
  assertEqual(s.plan, null, "no plan yet");
  assertEqual(h.promptCalls.length, 1, "promptPlanningRequest called exactly once");
  assertEqual(h.promptCalls[0].text, "build me a plan", "the same request text is the user message");
  assertEqual(h.promptCalls[0].filePaths?.length, 1, "attachments flow through promptPlanningRequest");
  assertEqual(h.session.customMessages.length, 1, "generation context injected once");
  assertEqual(h.session.customMessages[0].customType, "pix-plan-context", "generation context uses pix-plan-context");
  assertEqual(h.session.customMessages[0].context, "internal", "generation context is marked internal");
  assertEqual(h.session.customMessages[0].triggerTurn, false, "generation context does not trigger a turn");
  assert(
    typeof result.generationId === "string" && h.session.customMessages[0].content.includes(result.generationId),
    "generationId is model-visible",
  );
  assertEqual(h.session.activeTools.join(","), PLAN_ALLOWLIST.join(","), "allowlist tool surface applied");
  assertEqual(h.session.modelCalls[0]?.id, "faux-model", "planning model applied to the session");
  assertEqual(h.session.thinkingLevel, "high", "planning thinking level applied");
  const names = eventNames(h);
  assertEqual(names[0], "plan_mode_entered", "plan_mode_entered first");
  assertIncludes(names, "plan_generation_started", "plan_generation_started recorded");
});

await run("enterPlanning: empty request rejected without any prompt", async () => {
  const h = makeHarness();
  const c = makeController(h);
  const result = await c.enterPlanning({ text: "   " });
  assert(!result.ok, "empty request rejected");
  assertEqual(result.reason, "empty_request", "empty_request reason");
  assertEqual(h.promptCalls.length, 0, "no prompt written");
  assertEqual(h.session.customMessages.length, 0, "no custom message written");
  assertEqual(c.getSnapshot().planId, null, "no planId assigned");
});

await run("generation failure: settle without submit -> invalid_plan; three ops work", async () => {
  const h = makeHarness();
  const c = makeController(h);
  await c.enterPlanning({ text: "make a plan" });
  h.session.emitTurnSettled("stop");
  let s = c.getSnapshot();
  assertEqual(s.phase, "planning_failed", "initial failure -> planning_failed");
  assertEqual(s.failure?.code, "invalid_plan", "invalid_plan code");
  assertEqual(s.failure?.retryable, true, "retryable failure");
  const failureId = s.failure!.generationId;

  const retried = await c.retryGeneration(failureId);
  assert(retried.ok, "retryGeneration ok");
  assert(retried.generationId !== failureId, "retry creates a NEW generationId");
  s = c.getSnapshot();
  assertEqual(s.phase, "planning", "retry restores planning phase");
  assertEqual(s.generation?.generationId, retried.generationId, "generation state holds the new id");
  assertIncludes(
    h.session.customMessages.map((m) => m.customType),
    "pix-plan-retry",
    "retry uses the pix-plan-retry CustomMessage",
  );
  assert(
    h.session.customMessages.some((m) => m.customType === "pix-plan-retry" && m.context === "internal"),
    "retry CustomMessage is marked internal",
  );
  assert(
    h.session.customMessages.some((m) => m.triggerTurn === true),
    "retry CustomMessage triggers a turn",
  );
  assertEqual(h.session.activeTools.join(","), PLAN_ALLOWLIST.join(","), "allowlist re-applied on retry");

  // fail again, then use the frozen session model
  h.session.emitTurnSettled("stop");
  const failureId2 = c.getSnapshot().failure!.generationId;
  const sessionRetry = await c.useSessionModelAndRetry(failureId2);
  assert(sessionRetry.ok, "useSessionModelAndRetry ok");
  assert(sessionRetry.generationId !== failureId2, "use-session retry creates a new generationId");

  // stale token rejected
  const stale = await c.retryGeneration("bogus-generation");
  assert(!stale.ok, "stale generationId rejected");
  assertEqual(stale.reason, "stale_generation", "stale_generation reason");

  // user cancel of the in-flight generation
  const planId = c.getSnapshot().planId!;
  const cancelled = await c.cancel({ planId, generationId: sessionRetry.generationId! });
  assert(cancelled.ok, "generation cancel ok");
  s = c.getSnapshot();
  assertEqual(s.phase, "cancelled", "cancel -> cancelled");
  assertEqual(s.failure?.code, "cancelled", "cancel failure code");
  assertEqual(s.failure?.retryable, false, "cancelled is not retryable");
});

await run("generation failure: truncated stopReason classifies as truncated", async () => {
  const h = makeHarness();
  const c = makeController(h);
  await c.enterPlanning({ text: "make a plan" });
  h.session.emitTurnSettled("length");
  const s = c.getSnapshot();
  assertEqual(s.phase, "planning_failed", "truncated settle -> planning_failed");
  assertEqual(s.failure?.code, "truncated", "length stopReason -> truncated");
});

async function waitReal(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting after ${timeoutMs}ms`);
}

await run("generation failure: timeout watchdog aborts the turn and records timeout", async () => {
  const h = makeHarness();
  const c = makeController(h, { generationTimeoutMs: 40 });
  await c.enterPlanning({ text: "make a plan" });
  await waitReal(() => c.getSnapshot().failure?.code === "timeout");
  const s = c.getSnapshot();
  assertEqual(s.phase, "planning_failed", "timeout -> planning_failed");
  assert(s.failure!.retryable, "timeout failure retryable");
  assert(h.session.abortCalls >= 1, "the live turn was aborted on timeout");
  // stale settle after timeout must not overwrite the timeout classification
  h.session.emitTurnSettled("stop");
  assertEqual(c.getSnapshot().failure?.code, "timeout", "late settle does not overwrite timeout");
});

await run("G-1 timeout abort: late settle never kills a retried generation", async () => {
  const h = makeHarness();
  const c = makeController(h, { generationTimeoutMs: 40 });
  await c.enterPlanning({ text: "make a plan" });
  await waitReal(() => c.getSnapshot().failure?.code === "timeout");
  let s = c.getSnapshot();
  assertEqual(s.phase, "planning_failed", "timeout -> planning_failed");
  const timeoutFailureId = s.failure!.generationId;

  // The aborted turn has not settled yet: the live marker is retained, so a
  // retry before the late settle is rejected instead of starting a new
  // generation that the stale settle would mis-attribute and kill.
  const earlyRetry = await c.retryGeneration(timeoutFailureId);
  assert(!earlyRetry.ok, "retry before the late settle rejected");
  assertEqual(earlyRetry.reason, "generation_in_progress", "generation_in_progress reason");

  // The old turn's agent_end arrives: it only cleans up the aborted
  // generation and never overwrites the timeout failure.
  h.session.emitTurnSettled("stop");
  s = c.getSnapshot();
  assertEqual(s.failure?.code, "timeout", "late settle does not overwrite the timeout failure");
  assertEqual(s.phase, "planning_failed", "phase stays planning_failed");

  // Now the retry starts a fresh generation; its OWN settle fails only that
  // generation with invalid_plan.
  const retried = await c.retryGeneration(timeoutFailureId);
  assert(retried.ok, "retry after the late settle ok");
  const generationB = retried.generationId!;
  assert(generationB !== timeoutFailureId, "retry creates a new generationId");
  h.session.emitTurnSettled("stop");
  s = c.getSnapshot();
  assertEqual(s.failure?.generationId, generationB, "the new generation failed on its own settle");
  assertEqual(s.failure?.code, "invalid_plan", "new generation failure code invalid_plan");
});

await run("G-1 cancel abort: late settle of the cancelled turn only cleans up", async () => {
  const h = makeHarness();
  const c = makeController(h);
  await c.enterPlanning({ text: "make a plan" });
  const planId = c.getSnapshot().planId!;
  const generationId = c.getSnapshot().generation!.generationId;
  const cancelled = await c.cancel({ planId, generationId });
  assert(cancelled.ok, "generation cancel ok");
  let s = c.getSnapshot();
  assertEqual(s.phase, "cancelled", "cancel -> cancelled");
  assertEqual(s.failure?.code, "cancelled", "cancelled failure code");

  // The aborted turn's settle arrives later: cleanup only, never a failure
  // overwrite (cancelled is non-retryable; nothing can restart it).
  h.session.emitTurnSettled("stop");
  s = c.getSnapshot();
  assertEqual(s.failure?.code, "cancelled", "late settle keeps the cancelled failure");
  assertEqual(s.phase, "cancelled", "phase stays cancelled");
});

await run("G-1 rejectSubmission abort: late settle does not overwrite the rejection failure", async () => {
  const h = makeHarness();
  const c = makeController(h);
  const entered = await c.enterPlanning({ text: "plan" });
  const cycle = makeDraft();
  cycle.steps[0].dependsOn = ["s1"];
  const rejected = await c.submitPlan({ ...cycle, generationId: entered.generationId! });
  assert(!rejected.accepted, "cycle rejected");
  let s = c.getSnapshot();
  assertEqual(s.phase, "planning_failed", "rejection -> planning_failed");
  assertEqual(s.failure?.code, "invalid_plan", "invalid_plan failure");
  const failureId = s.failure!.generationId;

  // The submitting turn is still streaming: the live marker is retained, so
  // a retry before the late settle is rejected (never killed by it).
  const earlyRetry = await c.retryGeneration(failureId);
  assert(!earlyRetry.ok, "retry before the late settle rejected");
  assertEqual(earlyRetry.reason, "generation_in_progress", "generation_in_progress reason");

  // The old turn's settle arrives: cleanup only, the rejection failure stays.
  h.session.emitTurnSettled("stop");
  s = c.getSnapshot();
  assertEqual(s.failure?.code, "invalid_plan", "late settle keeps the rejection failure");
  assertEqual(s.phase, "planning_failed", "phase stays planning_failed");

  // After the settle a retry starts a fresh generation normally.
  const retried = await c.retryGeneration(failureId);
  assert(retried.ok, "retry after the late settle ok");
});

await run("G-2 planningModel: generation and plan record the RESOLVED execution model", async () => {
  // planModel differs from the parent session model: the controller must
  // record the model the turn really runs on (resolvePlanningModel), not the
  // frozen parent snapshot.
  const h = makeHarness({
    planningModel: { model: makeModel("plan-provider", "plan-model"), thinkingLevel: "low" },
  });
  const c = makeController(h);
  const entered = await c.enterPlanning({ text: "plan" });
  assert(entered.ok, "enterPlanning ok");
  let s = c.getSnapshot();
  assertEqual(s.generation?.model.modelId, "plan-model", "generation records the resolved model id");
  assertEqual(s.generation?.model.provider, "plan-provider", "generation records the resolved provider");
  assertEqual(s.generation?.model.thinkingLevel, "low", "generation records the resolved thinking level");
  assertEqual(h.session.modelCalls[0]?.id, "plan-model", "the resolved model was actually applied");

  const submitted = await c.submitPlan({ ...makeDraft(), generationId: entered.generationId! });
  assert(submitted.accepted, "draft accepted");
  s = c.getSnapshot();
  assertEqual(s.plan!.planningModel.modelId, "plan-model", "plan.planningModel records the resolved model");
  assertEqual(s.plan!.planningModel.thinkingLevel, "low", "plan.planningModel records the resolved thinking level");

  // A revision generation records the resolved model too (not the old
  // version's planningModel).
  const planId = s.planId!;
  const version = s.plan!.version;
  const revised = await c.requestRevision(planId, version, "revise it");
  assert(revised.ok, "requestRevision ok");
  s = c.getSnapshot();
  assertEqual(s.generation?.model.modelId, "plan-model", "revision generation records the resolved model");
  assertEqual(s.generation?.model.thinkingLevel, "low", "revision generation records the resolved thinking level");

  // useSessionModelAndRetry records the FROZEN first-enter parent model.
  const h2 = makeHarness({
    planningModel: { model: makeModel("plan-provider", "plan-model"), thinkingLevel: "low" },
  });
  const c2 = makeController(h2);
  await c2.enterPlanning({ text: "plan" });
  h2.session.emitTurnSettled("stop");
  const failureId = c2.getSnapshot().failure!.generationId;
  const retried = await c2.useSessionModelAndRetry(failureId);
  assert(retried.ok, "useSessionModelAndRetry ok");
  s = c2.getSnapshot();
  assertEqual(s.generation?.model.modelId, "faux-model", "use-session retry records the frozen parent model");
  assertEqual(s.generation?.model.provider, "faux", "use-session retry records the frozen provider");
  assertEqual(h2.session.modelCalls.at(-1)?.id, "faux-model", "the frozen model was actually applied");
});

await run("G-4 session_busy: retry/regenerate/revision gated while the session streams", async () => {
  const h = makeHarness();
  const c = makeController(h);
  await c.enterPlanning({ text: "make a plan" });
  h.session.emitTurnSettled("stop");
  const failureId = c.getSnapshot().failure!.generationId;
  h.session.isStreaming = true;
  const retried = await c.retryGeneration(failureId);
  assert(!retried.ok, "retryGeneration rejected while streaming");
  assertEqual(retried.reason, "session_busy", "session_busy reason");
  const regenerated = await c.regeneratePlan(failureId, true);
  assert(!regenerated.ok, "regeneratePlan rejected while streaming");
  assertEqual(regenerated.reason, "session_busy", "session_busy reason");

  const h2 = makeHarness();
  const c2 = makeController(h2);
  await c2.enterPlanning({ text: "plan" });
  const genId = c2.getSnapshot().generation!.generationId;
  await c2.submitPlan({ ...makeDraft(), generationId: genId });
  const s2 = c2.getSnapshot();
  h2.session.isStreaming = true;
  const revised = await c2.requestRevision(s2.planId!, s2.plan!.version, "too many steps");
  assert(!revised.ok, "requestRevision rejected while streaming");
  assertEqual(revised.reason, "session_busy", "session_busy reason");
  assertEqual(c2.getSnapshot().phase, "awaiting_approval", "no state change while gated");
});

await run("regeneratePlan: concise regeneration after failure", async () => {
  const h = makeHarness();
  const c = makeController(h);
  await c.enterPlanning({ text: "make a plan" });
  h.session.emitTurnSettled("stop");
  const failureId = c.getSnapshot().failure!.generationId;
  const regenerated = await c.regeneratePlan(failureId, true);
  assert(regenerated.ok, "regeneratePlan ok");
  assertEqual(c.getSnapshot().phase, "planning", "regenerate restores planning");
  assertEqual(c.getSnapshot().generation?.kind, "regenerate", "generation kind regenerate");
  assertEqual(c.getSnapshot().generation?.concise, true, "concise flag preserved");
  assert(
    h.session.customMessages.some((m) => m.content.includes("more concisely")),
    "concise retry message sent",
  );
  const stale = await c.regeneratePlan("bogus", false);
  assert(!stale.ok, "stale generationId rejected");
});

await run("submitPlan: accepted draft becomes version 1 awaiting approval", async () => {
  const h = makeHarness();
  const c = makeController(h);
  const { planId, version } = await driveToExecuting(c, h);
  assertEqual(version, 1, "first version is 1");
  const s = c.getSnapshot();
  assertEqual(s.phase, "executing", "driven to executing");
  assertEqual(s.plan!.planId, planId, "plan id stable");
  assertEqual(s.plan!.steps.length, 2, "two steps");
  const step0 = s.plan!.steps[0];
  const step1 = s.plan!.steps[1];
  assertEqual(step0.status, "pending", "step status pending after submit");
  assertEqual(step0.waitingReason, "", "waitingReason empty");
  assertEqual(step1.dependsOn.join(","), step0.stepId, "dependsOn rewritten to stepIds");
  assertEqual(s.generation, undefined, "generation cleared after success");
  assertEqual(s.failure, undefined, "failure cleared after success");
  assertIncludes(eventNames(h), "plan_generation_succeeded", "plan_generation_succeeded recorded");
});

await run("submitPlan: stale/unknown generationId rejected", async () => {
  const h = makeHarness();
  const c = makeController(h);
  await c.enterPlanning({ text: "plan" });
  const submitted = await c.submitPlan({ ...makeDraft(), generationId: "wrong" });
  assert(!submitted.accepted, "stale generationId rejected");
  assertEqual(submitted.fieldErrors?.[0]?.path, "generationId", "generationId field error");
});

await run("submitPlan: DAG cycle and unknown dependsOn rejected with planning_failed", async () => {
  const h = makeHarness();
  const c = makeController(h);
  const entered = await c.enterPlanning({ text: "plan" });
  const cycle = makeDraft();
  cycle.steps[0].dependsOn = ["s1"];
  const rejected = await c.submitPlan({ ...cycle, generationId: entered.generationId! });
  assert(!rejected.accepted, "cycle rejected");
  assert(
    rejected.fieldErrors?.some((e) => e.path === "steps" && e.message.includes("cycle")),
    "cycle field error",
  );
  assertEqual(c.getSnapshot().phase, "planning_failed", "initial validation failure -> planning_failed");
  assertEqual(c.getSnapshot().failure?.code, "invalid_plan", "invalid_plan failure");

  // unknown stepKey
  const h2 = makeHarness();
  const c2 = makeController(h2);
  const entered2 = await c2.enterPlanning({ text: "plan" });
  const unknown = makeDraft();
  unknown.steps[1].dependsOn = ["does-not-exist"];
  const rejected2 = await c2.submitPlan({ ...unknown, generationId: entered2.generationId! });
  assert(!rejected2.accepted, "unknown dependsOn rejected");
  assert(
    rejected2.fieldErrors?.some((e) => e.path === "steps.1.dependsOn"),
    "dependsOn field error path",
  );
});

await run("submitPlan: path semantics (absolute, glob, workspace escape) rejected", async () => {
  const h = makeHarness();
  const c = makeController(h);
  const entered = await c.enterPlanning({ text: "plan" });
  const absolute = makeDraft();
  absolute.steps[0].files = [{ path: join(WORKSPACE, "src", "a.txt"), operation: "read" }];
  const rejected = await c.submitPlan({ ...absolute, generationId: entered.generationId! });
  assert(!rejected.accepted, "absolute path rejected");
  assert(
    rejected.fieldErrors?.some((e) => e.path === "steps.0.files.0.path" && e.message.includes("absolute")),
    "absolute path field error",
  );

  const h2 = makeHarness();
  const c2 = makeController(h2);
  const entered2 = await c2.enterPlanning({ text: "plan" });
  const glob = makeDraft();
  glob.steps[0].files = [{ path: "src/*.ts", operation: "read" }];
  const rejected2 = await c2.submitPlan({ ...glob, generationId: entered2.generationId! });
  assert(!rejected2.accepted, "glob path rejected");
  assert(
    rejected2.fieldErrors?.some((e) => e.path === "steps.0.files.0.path" && e.message.includes("glob")),
    "glob field error",
  );

  const h3 = makeHarness();
  const c3 = makeController(h3);
  const entered3 = await c3.enterPlanning({ text: "plan" });
  const escape = makeDraft();
  escape.steps[0].files = [{ path: "../outside.txt", operation: "read" }];
  const rejected3 = await c3.submitPlan({ ...escape, generationId: entered3.generationId! });
  assert(!rejected3.accepted, "workspace escape rejected");
});

await run("submitPlan: 1.4.1 gate accepts subagent_background", async () => {
  const h = makeHarness();
  const c = makeController(h);
  const entered = await c.enterPlanning({ text: "plan" });
  const draft = makeDraft();
  draft.steps[0].executionTarget = "subagent_background";
  const submitted = await c.submitPlan({ ...draft, generationId: entered.generationId! });
  assert(submitted.accepted, "subagent_background accepted in 1.4.1");
  const s = c.getSnapshot();
  assertEqual(s.phase, "awaiting_approval", "awaiting_approval after acceptance");
  assertEqual(s.plan!.steps[0].executionTarget, "subagent_background", "executionTarget preserved");
});

await run("approve: awaiting_approval -> approved and restores parent model/tools", async () => {
  const h = makeHarness();
  const c = makeController(h);
  const entered = await c.enterPlanning({ text: "plan" });
  const submitted = await c.submitPlan({ ...makeDraft(), generationId: entered.generationId! });
  assert(submitted.accepted, "draft accepted");
  const s0 = c.getSnapshot();
  assertEqual(s0.phase, "awaiting_approval", "awaiting_approval after submit");
  const approved = await c.approve(s0.planId!, s0.plan!.version);
  assert(approved.ok, "approve ok");
  const s = c.getSnapshot();
  assertEqual(s.phase, "approved", "approved phase");
  assertEqual(s.plan!.status, "approved", "plan status approved");
  assert(
    h.session.activeTools.includes("bash") && h.session.activeTools.includes("write"),
    "parent tool surface restored (not the allowlist)",
  );
  await waitFor(() => h.session.modelCalls.length >= 2, 2000, "parent model restored after approve");
  assertIncludes(eventNames(h), "plan_approved", "plan_approved recorded");
  const stale = await c.approve(s0.planId!, 99);
  assert(!stale.ok, "stale version approve rejected");
  assertEqual(stale.reason, "stale_version", "stale_version reason");
});

await run("approve does not auto-execute; startExecution -> executing injects the step context", async () => {
  const h = makeHarness();
  const c = makeController(h);
  const entered = await c.enterPlanning({ text: "plan" });
  await c.submitPlan({ ...makeDraft(), generationId: entered.generationId! });
  const s0 = c.getSnapshot();
  await c.approve(s0.planId!, s0.plan!.version);
  assert(
    !h.session.customMessages.some((m) => m.triggerTurn === true),
    "approve alone never triggers a turn",
  );
  const started = await c.startExecution(s0.planId!, s0.plan!.version);
  assert(started.ok, "startExecution ok");
  const s = c.getSnapshot();
  assertEqual(s.phase, "executing", "executing phase");
  assertEqual(s.plan!.status, "executing", "plan status executing");
  assert(
    h.session.customMessages.some((m) => m.customType === "pix-plan-context" && m.triggerTurn === true && m.content.includes('Execute plan step "s0"')),
    "first parent step context injected with triggerTurn",
  );
  assertIncludes(eventNames(h), "plan_execution_started", "plan_execution_started recorded");
});

await run("read-only: start/retry/continue rejected without state change", async () => {
  const h = makeHarness();
  const c = makeController(h);
  const entered = await c.enterPlanning({ text: "plan" });
  await c.submitPlan({ ...makeDraft(), generationId: entered.generationId! });
  const s0 = c.getSnapshot();
  await c.approve(s0.planId!, s0.plan!.version);

  h.executionMode = "read-only";
  const start = await c.startExecution(s0.planId!, s0.plan!.version);
  assert(!start.ok, "startExecution rejected in read-only");
  assertEqual(start.reason, "read_only", "read_only reason");
  assertEqual(c.getSnapshot().phase, "approved", "state stays approved");

  // Move to paused first (approval mode), then gate continue/retry.
  h.executionMode = "approval";
  await c.startExecution(s0.planId!, s0.plan!.version);
  const step0 = c.getSnapshot().plan!.steps[0];
  const running = await c.updatePlanStep({
    planId: s0.planId!,
    version: s0.plan!.version,
    stepId: step0.stepId,
    status: "running",
  });
  assert(running.accepted, "step running accepted");
  const failed = await c.updatePlanStep({
    planId: s0.planId!,
    version: s0.plan!.version,
    stepId: step0.stepId,
    status: "failed",
    completionSummary: "blocked",
  });
  assert(failed.accepted, "step failure accepted");
  assertEqual(c.getSnapshot().phase, "paused", "failed step pauses the plan");

  h.executionMode = "read-only";
  const cont = await c.continuePlan(s0.planId!, s0.plan!.version);
  assert(!cont.ok, "continuePlan rejected in read-only");
  assertEqual(cont.reason, "read_only", "read_only reason");
  const retry = await c.retryStep(s0.planId!, s0.plan!.version, step0.stepId);
  assert(!retry.ok, "retryStep rejected in read-only");
  assertEqual(retry.reason, "read_only", "read_only reason");
  const s = c.getSnapshot();
  assertEqual(s.phase, "paused", "paused stays");
  assertEqual(s.plan!.steps[0].status, "failed", "failed step stays");
});

await run("update_plan_step: running, request_user_input waiting, unified completed gate", async () => {
  const h = makeHarness();
  const c = makeController(h);
  const { planId, version, step0, step1 } = await driveToExecuting(c, h);

  // dependencies + mutual exclusion
  const earlyRunning = await c.updatePlanStep({ planId, version, stepId: step1.stepId, status: "running" });
  assert(!earlyRunning.accepted, "dependent step cannot start before its dependency");
  const running = await c.updatePlanStep({ planId, version, stepId: step0.stepId, status: "running" });
  assert(running.accepted, "parent step running accepted");
  const second = await c.updatePlanStep({ planId, version, stepId: step1.stepId, status: "running" });
  assert(!second.accepted, "no second running step");

  // parent request_user_input: step -> waiting_input(user_input) -> running
  h.session.emit({ type: "tool_execution_start", toolCallId: "ui-1", toolName: "request_user_input", args: {} });
  let s = c.getSnapshot();
  const step0Now = s.plan!.steps.find((st) => st.stepId === step0.stepId)!;
  assertEqual(step0Now.status, "waiting_input", "request_user_input start marks the running step waiting_input");
  assertEqual(step0Now.waitingReason, "user_input", "waitingReason user_input");
  h.session.emit({ type: "tool_execution_end", toolCallId: "ui-1", toolName: "request_user_input", result: {}, isError: false });
  s = c.getSnapshot();
  assertEqual(
    s.plan!.steps.find((st) => st.stepId === step0.stepId)!.status,
    "running",
    "input end restores running",
  );

  // unified completed gate: summary + non-failed verificationResult required
  const noSummary = await c.updatePlanStep({ planId, version, stepId: step0.stepId, status: "completed" });
  assert(!noSummary.accepted, "completed without completionSummary rejected");
  const failedVerification = await c.updatePlanStep({
    planId,
    version,
    stepId: step0.stepId,
    status: "completed",
    completionSummary: "done",
    verificationResult: { status: "failed", summary: "tests fail" },
  });
  assert(!failedVerification.accepted, "completed with failed verificationResult rejected");
  const completed = await c.updatePlanStep({
    planId,
    version,
    stepId: step0.stepId,
    status: "completed",
    completionSummary: "inspected",
    verificationResult: { status: "passed", summary: "seams documented" },
  });
  assert(completed.accepted, "completed with evidence accepted");
  assert(
    h.session.customMessages.some((m) => m.content.includes('Execute plan step "s1"')),
    "next step context auto-injected after completion",
  );

  // completion criteria: all steps completed -> Plan completed
  const s1running = await c.updatePlanStep({ planId, version, stepId: step1.stepId, status: "running" });
  assert(s1running.accepted, "second step running after dependency completed");
  const s1completed = await c.updatePlanStep({
    planId,
    version,
    stepId: step1.stepId,
    status: "completed",
    completionSummary: "refactored",
    verificationResult: { status: "not_run", summary: "" },
  });
  assert(s1completed.accepted, "second step completed");
  s = c.getSnapshot();
  assertEqual(s.phase, "completed", "all steps completed -> completed");
  assertEqual(s.plan!.status, "completed", "plan status completed");
  assertIncludes(eventNames(h), "plan_execution_completed", "plan_execution_completed recorded");

  // late update after completion is rejected
  const late = await c.updatePlanStep({ planId, version, stepId: step0.stepId, status: "failed" });
  assert(!late.accepted, "late update after completion rejected");
});

await run("step failure pauses the plan and never mislabels completion", async () => {
  const h = makeHarness();
  const c = makeController(h);
  const { planId, version, step0 } = await driveToExecuting(c, h);
  const running = await c.updatePlanStep({ planId, version, stepId: step0.stepId, status: "running" });
  assert(running.accepted, "running accepted");
  const failed = await c.updatePlanStep({ planId, version, stepId: step0.stepId, status: "failed", completionSummary: "blocked" });
  assert(failed.accepted, "failed accepted");
  const s = c.getSnapshot();
  assertEqual(s.phase, "paused", "failed step -> paused");
  assertEqual(s.plan!.status, "paused", "plan status paused");
  assertIncludes(eventNames(h), "plan_execution_failed", "plan_execution_failed recorded");

  // retryStep: failed -> running (approval mode)
  const retried = await c.retryStep(planId, version, step0.stepId);
  assert(retried.ok, "retryStep ok");
  const s2 = c.getSnapshot();
  assertEqual(s2.phase, "executing", "retry resumes executing");
  assertEqual(s2.plan!.steps[0].status, "running", "retried step running");
  const notFailed = await c.retryStep(planId, version, step0.stepId);
  assert(!notFailed.ok, "non-failed step cannot be retried");
});

await run("skipStep: phase gate; dependent step refused; independent step skippable", async () => {
  // G-3: skip is only legal while executing/paused. Skipping before approval
  // would strand the plan in approved with no runnable step (startExecution
  // would return no_runnable_step forever, and approved has no completion
  // exit), so awaiting_approval must reject.
  const h1 = makeHarness();
  const c1 = makeController(h1);
  const entered1 = await c1.enterPlanning({ text: "plan" });
  await c1.submitPlan({ ...makeDraft(), generationId: entered1.generationId! });
  const s1 = c1.getSnapshot();
  const gated = c1.skipStep(s1.planId!, s1.plan!.version, s1.plan!.steps[1].stepId);
  assert(!gated.ok, "skip from awaiting_approval rejected");
  assert(gated.reason!.includes("cannot skip"), "phase gate reason");
  assertEqual(s1.plan!.steps[1].status, "pending", "step untouched");

  const h = makeHarness();
  const c = makeController(h);
  const { planId, version, step0, step1 } = await driveToExecuting(c, h);
  const blocked = c.skipStep(planId, version, step0.stepId);
  assert(!blocked.ok, "step with dependents cannot be skipped");
  assert(blocked.reason!.includes("dependent"), "dependent reason");
  const skipped = c.skipStep(planId, version, step1.stepId);
  assert(skipped.ok, "independent pending step skipped");
  assertEqual(
    c.getSnapshot().plan!.steps.find((st) => st.stepId === step1.stepId)!.status,
    "skipped",
    "step status skipped",
  );
});

await run("skipStep: paused with all remaining steps skipped transitions to completed (paused -> completed)", async () => {
  // A plan paused with one completed step and one pending step (reachable via
  // a session-close/hydration pause without a failed step) completes when the
  // last pending step is skipped: the host transition legally writes completed
  // from paused (PLAN_TRANSITIONS.paused includes "completed").
  const snap: Parameters<typeof serializePlanRecord>[0] = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    phase: "paused",
    planId: "plan-1",
    plan: {
      schemaVersion: PLAN_SCHEMA_VERSION,
      planId: "plan-1",
      version: 1,
      status: "paused",
      title: "t",
      summary: "s",
      planningModel: { provider: "faux", modelId: "faux-model", thinkingLevel: "off" },
      steps: [
        {
          stepKey: "s0",
          stepId: "step-done",
          title: "t",
          description: "d",
          files: [],
          executionTarget: "parent",
          risk: "low",
          riskReason: "r",
          effort: "small",
          verification: "v",
          dependsOn: [],
          status: "completed",
          waitingReason: "",
          completionSummary: "done",
          verificationResult: { status: "passed", summary: "ok" },
        },
        {
          stepKey: "s1",
          stepId: "step-pending",
          title: "t",
          description: "d",
          files: [],
          executionTarget: "parent",
          risk: "low",
          riskReason: "r",
          effort: "small",
          verification: "v",
          dependsOn: ["step-done"],
          status: "pending",
          waitingReason: "",
        },
      ],
      createdAt: 1000,
      updatedAt: 1000,
    },
    deviations: [],
    updatedAt: 1000,
  };
  const entry = (data: unknown): SessionEntry =>
    ({ type: "custom", id: "e", parentId: null, timestamp: "t", customType: "pix-plan-v1", data }) as SessionEntry;
  const h = makeHarness();
  const c = makeController(h);
  await c.restoreFromHistory([entry(serializePlanRecord(snap, "plan_execution_failed", 1))]);
  const s = c.getSnapshot();
  assertEqual(s.phase, "paused", "paused plan hydrated as-is");
  const skipped = c.skipStep("plan-1", 1, "step-pending");
  assert(skipped.ok, "pending step skipped while paused");
  const s2 = c.getSnapshot();
  assertEqual(s2.phase, "completed", "paused -> completed via skip of the last pending step");
  assertEqual(s2.plan!.status, "completed", "plan status completed");
  assertIncludes(eventNames(h), "plan_execution_completed", "plan_execution_completed recorded");
});

await run("revision: base preserved, failed revision keeps revising, fallback restores", async () => {
  const h = makeHarness();
  const c = makeController(h);
  const entered = await c.enterPlanning({ text: "plan" });
  await c.submitPlan({ ...makeDraft(), generationId: entered.generationId! });
  const s0 = c.getSnapshot();
  const planId = s0.planId!;

  const revised = await c.requestRevision(planId, 1, "too many steps", "s1");
  assert(revised.ok, "requestRevision ok");
  let s = c.getSnapshot();
  assertEqual(s.phase, "revising", "revising phase");
  assertEqual(s.plan!.version, 1, "base plan still displayed");
  assertEqual(s.plan!.status, "revising", "base plan status revising");
  assertEqual(s.lastValidPlan?.version, 1, "lastValidPlan keeps the base");
  assertEqual(s.revision?.baseVersion, 1, "revision baseVersion");
  assertEqual(s.revision?.requestedVersion, 2, "revision requestedVersion");
  assertIncludes(eventNames(h), "plan_revision_requested", "plan_revision_requested recorded");

  // revision without basedOnVersion is rejected and keeps revising
  const missingBase = await c.submitPlan({ ...makeDraft(), generationId: revised.generationId! });
  assert(!missingBase.accepted, "revision without basedOnVersion rejected");
  assert(
    missingBase.fieldErrors?.some((e) => e.path === "basedOnVersion"),
    "basedOnVersion field error",
  );
  s = c.getSnapshot();
  assertEqual(s.phase, "revising", "rejected revision keeps revising");
  assertEqual(s.plan!.version, 1, "no half-valid new version");
  assert(s.lastValidPlan !== undefined, "lastValidPlan kept");

  // The rejecting turn is still streaming: its late settle must arrive before
  // the retry can start a new generation (the abort marker is retained until
  // then; the settle only cleans up, keeping the rejection failure).
  h.session.emitTurnSettled("stop");
  assertEqual(c.getSnapshot().failure?.code, "invalid_plan", "late settle keeps the rejection failure");

  // retry the revision (new generation) and submit a valid candidate
  const retried = await c.retryGeneration(s.failure!.generationId);
  assert(retried.ok, "revision retry ok");
  const draft2 = makeDraft();
  draft2.basedOnVersion = 1;
  const submitted = await c.submitPlan({ ...draft2, generationId: retried.generationId! });
  assert(submitted.accepted, "valid revision accepted");
  s = c.getSnapshot();
  assertEqual(s.phase, "awaiting_approval", "revision success -> awaiting_approval");
  assertEqual(s.plan!.version, 2, "candidate becomes version 2");
  assertEqual(s.lastValidPlan, undefined, "lastValidPlan cleared after success");
  assertEqual(s.revision, undefined, "revision state cleared");
});

await run("revision failure fallback: returnToPreviousVersion restores awaiting_approval", async () => {
  const h = makeHarness();
  const c = makeController(h);
  const entered = await c.enterPlanning({ text: "plan" });
  await c.submitPlan({ ...makeDraft(), generationId: entered.generationId! });
  const planId = c.getSnapshot().planId!;
  const revised = await c.requestRevision(planId, 1, "revise it");
  assert(revised.ok, "requestRevision ok");
  // make the revision fail (invalid_plan via a cycle)
  const cycle = makeDraft();
  cycle.steps[0].dependsOn = ["s1"];
  await c.submitPlan({ ...cycle, generationId: revised.generationId! });
  let s = c.getSnapshot();
  assertEqual(s.phase, "revising", "failed revision keeps revising");
  assertEqual(s.failure?.code, "invalid_plan", "invalid_plan failure recorded");

  const wrong = c.returnToPreviousVersion(planId, 2);
  assert(!wrong.ok, "fallback to a non-base version rejected");
  const restored = c.returnToPreviousVersion(planId, 1);
  assert(restored.ok, "fallback to base version ok");
  s = c.getSnapshot();
  assertEqual(s.phase, "awaiting_approval", "base restored to awaiting_approval");
  assertEqual(s.plan!.version, 1, "base version restored");
  assertEqual(s.lastValidPlan, undefined, "lastValidPlan cleared");
  assertEqual(s.revision, undefined, "revision state cleared");
});

await run("cancel with valid plan cancels unfinished steps; late version rejected", async () => {
  const h = makeHarness();
  const c = makeController(h);
  const { planId, version } = await driveToExecuting(c, h);
  const cancelled = await c.cancel({ planId, version });
  assert(cancelled.ok, "plan cancel ok");
  const s = c.getSnapshot();
  assertEqual(s.phase, "cancelled", "cancelled phase");
  assertEqual(s.plan!.status, "cancelled", "plan status cancelled");
  for (const step of s.plan!.steps) {
    assertEqual(step.status, "cancelled", `unfinished step ${step.stepKey} cancelled`);
  }
  const late = await c.cancel({ planId, version });
  assert(!late.ok, "late cancel of a cancelled plan rejected");
  assertIncludes(eventNames(h), "plan_execution_cancelled", "plan_execution_cancelled recorded");
});

await run("decideToolPolicy: planning allowlist authoritative, non-planning undefined", async () => {
  const h = makeHarness();
  const c = makeController(h);
  await c.enterPlanning({ text: "plan" });
  const input = (toolName: string): HostToolPolicyInput => ({
    mode: "read-only",
    toolName,
    args: {},
    cwd: WORKSPACE,
  });
  for (const tool of PLAN_ALLOWLIST) {
    const d = c.decideToolPolicy(input(tool));
    assert(d?.allowed === true, `planning allows ${tool}`);
  }
  const denied = c.decideToolPolicy(input("bash"));
  assert(denied?.allowed === false, "planning denies bash");
  const deniedExt = c.decideToolPolicy(input("some_mcp_tool"));
  assert(deniedExt?.allowed === false, "planning denies unknown extension/MCP tools");
  const deniedWrite = c.decideToolPolicy(input("write"));
  assert(deniedWrite?.allowed === false, "planning denies write even in read-only");
  // non-planning phases fall back to the default policy
  await c.cancel({ planId: c.getSnapshot().planId!, generationId: c.getSnapshot().generation!.generationId });
  assertEqual(c.decideToolPolicy(input("read")), undefined, "non-planning returns undefined");
});

await run("reload gate: allowlist tool surface re-applied on every generation", async () => {
  const h = makeHarness();
  const c = makeController(h);
  await c.enterPlanning({ text: "plan" });
  h.session.emitTurnSettled("stop");
  // simulate an extension reload widening the tool surface
  h.session.setActiveToolsByName(["read", "bash", "edit", "write", "grep", "find", "ls", "agent", "some_mcp_tool"]);
  const failureId = c.getSnapshot().failure!.generationId;
  await c.retryGeneration(failureId);
  assertEqual(h.session.activeTools.join(","), PLAN_ALLOWLIST.join(","), "allowlist re-applied after reload-like tool drift");
});

await run("deviations: parent file/command scope detection on the running step", async () => {
  const h = makeHarness();
  const c = makeController(h);
  const { planId, version, step0 } = await driveToExecuting(c, h);
  await c.updatePlanStep({ planId, version, stepId: step0.stepId, status: "running" });

  h.session.emit({
    type: "file_change",
    toolCallId: "fc-1",
    toolName: "edit",
    change: { path: "src/undeclared.txt", toolCallId: "fc-1", toolName: "edit", added: 1, removed: 0 },
    aggregate: { added: 1, removed: 0, files: 1, changes: [] },
  });
  await waitFor(() => c.getSnapshot().deviations.length === 1, 20000, "file deviation recorded");
  let s = c.getSnapshot();
  assertEqual(s.deviations[0].type, "file_out_of_scope", "file deviation type");
  assertEqual(s.deviations[0].stepId, step0.stepId, "deviation bound to the running step");

  // declared file change is not a deviation
  h.session.emit({
    type: "file_change",
    toolCallId: "fc-2",
    toolName: "edit",
    change: { path: "src/a.txt", toolCallId: "fc-2", toolName: "edit", added: 0, removed: 1 },
    aggregate: { added: 0, removed: 1, files: 1, changes: [] },
  });
  await waitFor(() => c.getSnapshot().deviations.length === 1, 2000, "no second deviation");
  assertEqual(c.getSnapshot().deviations.length, 1, "declared edit stays clean");

  // command deviation: unexpected command flagged, expected command clean
  h.session.emit({ type: "tool_execution_start", toolCallId: "tc-1", toolName: "bash", args: { command: "rm -rf /" } });
  await waitFor(() => c.getSnapshot().deviations.length === 2, 2000, "command deviation recorded");
  s = c.getSnapshot();
  assertEqual(s.deviations[1].type, "command_out_of_scope", "command deviation type");
  h.session.emit({ type: "tool_execution_start", toolCallId: "tc-2", toolName: "bash", args: { command: "npm test -- --coverage" } });
  await waitFor(() => c.getSnapshot().deviations.length === 2, 2000, "expected command stays clean");
  assertEqual(c.getSnapshot().deviations.length, 2, "expected command not flagged");
});

await run("subagent_foreground: controller runs the step, injects the result, deviations recorded", async () => {
  const h = makeHarness();
  const c = makeController(h);
  const draft = makeDraft();
  draft.steps[0].executionTarget = "subagent_foreground";
  h.delegateResult = {
    stepId: "ignored",
    status: "result",
    summary: "subagent refactored everything",
    deviations: [
      {
        type: "file_out_of_scope",
        stepId: "x",
        toolCallId: "nested-fc-1",
        path: "vendor/lib.js",
        reason: "not declared",
        detectedAt: Date.now(),
      } satisfies PlanDeviation,
    ],
  };
  const entered = await c.enterPlanning({ text: "plan" });
  await c.submitPlan({ ...draft, generationId: entered.generationId! });
  const s0 = c.getSnapshot();
  await c.approve(s0.planId!, s0.plan!.version);
  const started = await c.startExecution(s0.planId!, s0.plan!.version);
  assert(started.ok, "startExecution ok");
  await waitFor(() => h.delegated.length === 1, 2000, "step delegated");
  assertEqual(h.delegated[0].presentation, "foreground", "foreground presentation");
  assertEqual(h.delegated[0].link.planId, s0.planId, "delegation carries the plan link");
  assertEqual(h.delegated[0].link.stepId, s0.plan!.steps[0].stepId, "delegation link stepId");
  const s = c.getSnapshot();
  assertEqual(s.phase, "executing", "plan stays executing after the delegation result");
  assertEqual(s.plan!.steps[0].status, "running", "step stays running; the parent model must verify");
  assert(
    h.session.customMessages.some((m) => m.content.includes("Verify the subagent's work")),
    "subagent result injected into the parent turn",
  );
  assertEqual(s.deviations.length, 1, "delegated deviations recorded into the snapshot");

  // the unified gate still applies: the parent model cannot complete without evidence
  const step0 = s.plan!.steps[0];
  const gated = await c.updatePlanStep({
    planId: s0.planId!,
    version: s0.plan!.version,
    stepId: step0.stepId,
    status: "completed",
  });
  assert(!gated.accepted, "subagent path cannot bypass the completed gate");

  // A6: the parent verification turn is a live execution turn. A settle
  // without update_plan_step must fail the still-running step (same as the
  // parent-direct path), not leave the plan executing forever.
  h.session.emitTurnSettled("stop");
  assertEqual(c.getSnapshot().plan!.steps[0].status, "failed", "unanswered parent verification turn fails the step");
  assertEqual(c.getSnapshot().phase, "paused", "plan pauses after the unanswered verification turn");
});

await run("subagent_background: delegation backgrounded -> waiting_input(agent_task) + plan paused", async () => {
  const h = makeHarness();
  const c = makeController(h);
  const draft = makeDraft();
  draft.steps[0].executionTarget = "subagent_background";
  h.delegateResult = { stepId: "x", status: "backgrounded", groupId: "group-1", taskIds: ["t1"] };
  const entered = await c.enterPlanning({ text: "plan" });
  await c.submitPlan({ ...draft, generationId: entered.generationId! });
  const s0 = c.getSnapshot();
  await c.approve(s0.planId!, s0.plan!.version);
  const started = await c.startExecution(s0.planId!, s0.plan!.version);
  assert(started.ok, "startExecution ok");
  await waitFor(() => h.delegated.length === 1, 2000, "step delegated");
  assertEqual(h.delegated[0].presentation, "background", "background presentation forced by the controller");
  assertEqual(h.delegated[0].link.planId, s0.planId, "delegation carries the plan link");
  const s = c.getSnapshot();
  assertEqual(s.phase, "paused", "backgrounded delegation pauses the plan");
  assertEqual(s.plan!.status, "paused", "plan status paused");
  const step = s.plan!.steps[0];
  assertEqual(step.status, "waiting_input", "step waits for the background task");
  assertEqual(step.waitingReason, "agent_task", "waitingReason agent_task");
  assertEqual(step.waitingTaskGroupId, "group-1", "waitingTaskGroupId recorded");
  assertEqual(step.consumedTaskGroupId, undefined, "no consumed fact yet");
  // The parent model never saw the group handle: no triggered pix-plan-context turn.
  assert(
    !h.session.customMessages.some((m) => m.triggerTurn === true),
    "no parent turn for the backgrounded step",
  );
});

async function driveToBackgrounded(c: PlanController, h: Harness, groupId = "group-1"): Promise<{ planId: string; version: number; step: PlanStep }> {
  const draft = makeDraft();
  draft.steps[0].executionTarget = "subagent_background";
  h.delegateResult = { stepId: "x", status: "backgrounded", groupId, taskIds: [`t-${groupId}`] };
  const entered = await c.enterPlanning({ text: "plan" });
  await c.submitPlan({ ...draft, generationId: entered.generationId! });
  const s0 = c.getSnapshot();
  await c.approve(s0.planId!, s0.plan!.version);
  const started = await c.startExecution(s0.planId!, s0.plan!.version);
  assert(started.ok, "startExecution ok");
  await waitFor(() => h.delegated.length === 1, 2000, "step delegated");
  const s = c.getSnapshot();
  return { planId: s.planId!, version: s.plan!.version, step: s.plan!.steps[0] };
}

await run("continuePlan: completed group consumed with confirm + parent verification turn", async () => {
  const h = makeHarness();
  const c = makeController(h);
  const { planId, version, step } = await driveToBackgrounded(c, h);
  h.taskGroupResults.set("group-1", { status: "completed", summary: "background work done" });

  const cont = await c.continuePlan(planId, version);
  assert(cont.ok, "continuePlan ok");
  const s = c.getSnapshot();
  assertEqual(s.phase, "executing", "completed consumption resumes executing");
  assertEqual(s.plan!.status, "executing", "plan status executing");
  const stepNow = s.plan!.steps.find((st) => st.stepId === step.stepId)!;
  assertEqual(stepNow.status, "running", "step running; the parent model verifies");
  assertEqual(stepNow.waitingReason, "", "waiting fields cleared on consumption");
  assertEqual(stepNow.waitingTaskGroupId, undefined, "waitingTaskGroupId cleared");
  assertEqual(stepNow.consumedTaskGroupId, "group-1", "consumedTaskGroupId persisted");
  assertEqual(stepNow.consumedTaskSummary, "background work done", "consumedTaskSummary persisted");
  assertEqual(h.confirmCalls.length, 1, "consumption confirm called exactly once");
  assertEqual(h.confirmCalls[0].groupId, "group-1", "confirm targets the group");
  assertEqual(h.confirmCalls[0].link.stepId, step.stepId, "confirm carries the step link");
  assertEqual(h.releaseCalls.length, 0, "consumption never releases");
  assert(
    h.session.customMessages.some((m) => m.triggerTurn === true && m.content.includes("Verify the task's work")),
    "completed consumption triggers the parent verification turn",
  );
  // After consumption the plan is executing; continuePlan (paused -> executing)
  // is rejected rather than double-consuming.
  const again = await c.continuePlan(planId, version);
  assert(!again.ok, "continuePlan rejects once the plan is executing again");
  assert(again.reason!.includes("executing"), "executing-phase rejection reason");
});

await run("continuePlan: failed/cancelled group consumed as step failed; cancelled is never a release", async () => {
  // failed
  const h = makeHarness();
  const c = makeController(h);
  const { planId, version, step } = await driveToBackgrounded(c, h, "group-fail");
  h.taskGroupResults.set("group-fail", { status: "failed", summary: "the task failed" });
  const cont = await c.continuePlan(planId, version);
  assert(cont.ok, "continuePlan ok (failed)");
  let s = c.getSnapshot();
  assertEqual(s.phase, "paused", "failed consumption keeps the plan paused");
  const failedStep = s.plan!.steps.find((st) => st.stepId === step.stepId)!;
  assertEqual(failedStep.status, "failed", "failed group fails the step");
  assertEqual(failedStep.consumedTaskGroupId, "group-fail", "failed consumption persisted");
  assertEqual(h.confirmCalls.length, 1, "failed consumption confirmed (lifts cleanup protection)");
  assertEqual(h.releaseCalls.length, 0, "failed consumption never releases");

  // cancelled: consumed (not released); only revision success / overall cancel release.
  const h2 = makeHarness();
  const c2 = makeController(h2);
  const { planId: planId2, version: version2 } = await driveToBackgrounded(c2, h2, "group-cancel");
  h2.taskGroupResults.set("group-cancel", { status: "cancelled", summary: "the task was cancelled" });
  const cont2 = await c2.continuePlan(planId2, version2);
  assert(cont2.ok, "continuePlan ok (cancelled)");
  s = c2.getSnapshot();
  assertEqual(s.phase, "paused", "cancelled consumption keeps the plan paused");
  assertEqual(s.plan!.steps[0].status, "failed", "cancelled group fails the step");
  assertEqual(s.plan!.steps[0].consumedTaskGroupId, "group-cancel", "cancelled consumption persisted");
  assertEqual(h2.confirmCalls.length, 1, "cancelled consumption confirmed");
  assertEqual(h2.releaseCalls.length, 0, "cancelled is NOT a link release");
});

await run("continuePlan: non-terminal group stays paused; no deadlock", async () => {
  const h = makeHarness();
  const c = makeController(h);
  const { planId, version, step } = await driveToBackgrounded(c, h);
  // No entry in taskGroupResults -> group_not_terminal.
  const cont = await c.continuePlan(planId, version);
  assert(!cont.ok, "continuePlan rejected while the group is not terminal");
  assertEqual(cont.reason, "group_not_terminal", "group_not_terminal reason");
  const s = c.getSnapshot();
  assertEqual(s.phase, "paused", "plan stays paused");
  assertEqual(s.plan!.steps.find((st) => st.stepId === step.stepId)!.status, "waiting_input", "step stays waiting");
  assertEqual(h.confirmCalls.length, 0, "no confirm on a non-terminal group");
  assertEqual(h.releaseCalls.length, 0, "no release on a non-terminal group");
});

await run("startExecution cannot bypass a waiting background task", async () => {
  const h = makeHarness();
  const c = makeController(h);
  const { planId, version } = await driveToBackgrounded(c, h);
  const start = await c.startExecution(planId, version);
  assert(!start.ok, "startExecution rejected while a background task waits");
  assertEqual(start.reason, "background_task_waiting", "background_task_waiting reason");
  assertEqual(c.getSnapshot().phase, "paused", "state unchanged");
});

await run("revision: requestRevision never releases; success releases plan_revised; failure never releases", async () => {
  // 1. requestRevision itself must not release the old link.
  const h = makeHarness();
  const c = makeController(h);
  const { planId, version, step } = await driveToBackgrounded(c, h);
  const oldStepId = step.stepId;
  const revised = await c.requestRevision(planId, version, "too slow");
  assert(revised.ok, "requestRevision ok");
  assertEqual(h.releaseCalls.length, 0, "requestRevision does not release the old link");

  // 2. A failed revision keeps the base untouched; nothing is released.
  const cycle = makeDraft();
  cycle.steps[0].dependsOn = ["s1"];
  await c.submitPlan({ ...cycle, generationId: revised.generationId! });
  assertEqual(c.getSnapshot().phase, "revising", "failed revision keeps revising");
  assertEqual(h.releaseCalls.length, 0, "failed revision never releases");

  // 3. A successful revision atomically publishes version+1 then releases.
  // The rejecting turn's late settle must arrive before the retry starts a
  // new generation (abort marker retained until then; settle is cleanup only).
  h.session.emitTurnSettled("stop");
  const retried = await c.retryGeneration(c.getSnapshot().failure!.generationId);
  assert(retried.ok, "revision retry ok");
  const draft2 = makeDraft();
  draft2.steps[0].executionTarget = "subagent_background";
  draft2.basedOnVersion = 1;
  const submitted = await c.submitPlan({ ...draft2, generationId: retried.generationId! });
  assert(submitted.accepted, "successful revision accepted");
  assertEqual(h.releaseCalls.length, 1, "successful revision releases exactly the pending link");
  assertEqual(h.releaseCalls[0].groupId, "group-1", "released groupId");
  assertEqual(h.releaseCalls[0].reason, "plan_revised", "plan_revised reason");
  assertEqual(h.releaseCalls[0].link.version, 1, "release links the old version");
  assertEqual(h.releaseCalls[0].link.stepId, oldStepId, "release links the old step, not the new version's step");
  const s = c.getSnapshot();
  assertEqual(s.pendingTaskLinkReleases, undefined, "release intent cleared after success");
  assertEqual(s.plan!.version, 2, "new version published");
});

await run("cancel: overall cancel releases pending task links (plan_cancelled)", async () => {
  const h = makeHarness();
  const c = makeController(h);
  const { planId, version } = await driveToBackgrounded(c, h);
  const cancelled = await c.cancel({ planId, version });
  assert(cancelled.ok, "cancel ok");
  assertEqual(h.releaseCalls.length, 1, "cancel releases the pending link");
  assertEqual(h.releaseCalls[0].groupId, "group-1", "released groupId");
  assertEqual(h.releaseCalls[0].reason, "plan_cancelled", "plan_cancelled reason");
  const s = c.getSnapshot();
  assertEqual(s.phase, "cancelled", "cancelled phase");
  assertEqual(s.pendingTaskLinkReleases, undefined, "release intent cleared");
  assertEqual(s.plan!.steps[0].waitingTaskGroupId, undefined, "waiting field cleared on cancel");
});

await run("dispose matrix: session_close keeps task-linked waiting; app_shutdown/host_disposed write interrupted", async () => {
  // session_close: the detached group continues in-app; the step survives.
  const h = makeHarness();
  const c = makeController(h);
  await driveToBackgrounded(c, h);
  await c.dispose("session_close");
  let s = c.getSnapshot();
  assertEqual(s.phase, "paused", "session_close keeps the plan paused");
  assertEqual(s.plan!.steps[0].status, "waiting_input", "session_close keeps the step waiting");
  assertEqual(s.plan!.steps[0].waitingReason, "agent_task", "waitingReason preserved");
  assertEqual(s.plan!.steps[0].waitingTaskGroupId, "group-1", "waitingTaskGroupId preserved");

  // app_shutdown (1.4.2 R4): the task-linked step stays non-terminal as
  // interrupted, keeping the recoverable link facts; never failed first and
  // rewritten, never clears the waiting fields.
  const h2 = makeHarness();
  const c2 = makeController(h2);
  await driveToBackgrounded(c2, h2);
  await c2.dispose("app_shutdown");
  s = c2.getSnapshot();
  assertEqual(s.phase, "paused", "app_shutdown pauses the plan");
  assertEqual(s.plan!.steps[0].status, "interrupted", "app_shutdown writes the task-linked step interrupted");
  assertEqual(s.plan!.steps[0].waitingReason, "agent_task", "app_shutdown keeps waitingReason agent_task");
  assertEqual(s.plan!.steps[0].waitingTaskGroupId, "group-1", "app_shutdown keeps waitingTaskGroupId");
  assertEqual(s.plan!.steps[0].consumedTaskGroupId, undefined, "shutdown writes no consumed fact");

  // host_disposed behaves like app_shutdown.
  const h3 = makeHarness();
  const c3 = makeController(h3);
  await driveToBackgrounded(c3, h3);
  await c3.dispose("host_disposed");
  s = c3.getSnapshot();
  assertEqual(s.plan!.steps[0].status, "interrupted", "host_disposed writes the task-linked step interrupted");
  assertEqual(s.plan!.steps[0].waitingTaskGroupId, "group-1", "host_disposed keeps waitingTaskGroupId");
});

await run("hydration: task-linked waiting hydrates interrupted; release intents replayed; consumed re-confirmed", async () => {
  // 1. A session-close snapshot with a task-linked waiting step hydrates to
  //    interrupted (1.4.2 R4, link facts kept) and can still be consumed.
  const h1 = makeHarness();
  const c1 = makeController(h1);
  const { planId, version } = await driveToBackgrounded(c1, h1);
  await c1.dispose("session_close");
  const h1b = makeHarness();
  const c1b = makeController(h1b);
  await c1b.restoreFromHistory(h1.manager.getEntries());
  let s = c1b.getSnapshot();
  assertEqual(s.phase, "paused", "task-linked plan stays paused on hydration");
  assertEqual(s.plan!.steps[0].status, "interrupted", "task-linked waiting step hydrates to interrupted");
  assertEqual(s.plan!.steps[0].waitingReason, "agent_task", "waitingReason agent_task survives hydration");
  assertEqual(s.plan!.steps[0].waitingTaskGroupId, "group-1", "waitingTaskGroupId survives hydration");
  h1b.taskGroupResults.set("group-1", { status: "completed", summary: "finished later" });
  const cont = await c1b.continuePlan(planId, version);
  assert(cont.ok, "hydrated interrupted step consumable via continuePlan");
  assertEqual(c1b.getSnapshot().plan!.steps[0].consumedTaskGroupId, "group-1", "consumed after hydration");

  // 2. Crash between the consumption write and the confirm: the persisted
  //    consumedTaskGroupId triggers an idempotent re-confirm on hydration.
  const snap: Parameters<typeof serializePlanRecord>[0] = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    phase: "paused",
    planId: "plan-1",
    plan: {
      schemaVersion: PLAN_SCHEMA_VERSION,
      planId: "plan-1",
      version: 1,
      status: "paused",
      title: "t",
      summary: "s",
      planningModel: { provider: "faux", modelId: "faux-model", thinkingLevel: "off" },
      steps: [
        {
          stepKey: "s0",
          stepId: "step-1",
          title: "t",
          description: "d",
          files: [],
          executionTarget: "subagent_background",
          risk: "low",
          riskReason: "r",
          effort: "small",
          verification: "v",
          dependsOn: [],
          status: "failed",
          waitingReason: "",
          consumedTaskGroupId: "group-consumed",
          consumedTaskSummary: "done",
          completionSummary: "x",
          verificationResult: { status: "passed", summary: "ok" },
        },
      ],
      createdAt: 1000,
      updatedAt: 1000,
    },
    pendingTaskLinkReleases: [
      { groupId: "group-pending", link: { planId: "plan-1", version: 1, stepId: "step-2" }, reason: "plan_revised" },
    ],
    deviations: [],
    updatedAt: 1000,
  };
  const entry = (data: unknown): SessionEntry =>
    ({ type: "custom", id: "e", parentId: null, timestamp: "t", customType: "pix-plan-v1", data }) as SessionEntry;
  const h2 = makeHarness();
  const c2 = makeController(h2);
  await c2.restoreFromHistory([entry(serializePlanRecord(snap, "plan_link_release_pending", 1))]);
  assert(
    h2.confirmCalls.some((call) => call.groupId === "group-consumed" && call.link.version === 1 && call.link.stepId === "step-1"),
    "consumed group re-confirmed from consumedTaskGroupId on hydration",
  );
  assert(
    h2.releaseCalls.some((call) => call.groupId === "group-pending" && call.reason === "plan_revised"),
    "pending release intent replayed on hydration",
  );
  assertEqual(c2.getSnapshot().pendingTaskLinkReleases, undefined, "replayed intent cleared");
});

await run("1.4.2 hydration: crash snapshot -> task-linked interrupted (link facts kept), direct parent steps failed, plan paused", async () => {
  const snap: Parameters<typeof serializePlanRecord>[0] = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    phase: "executing",
    planId: "plan-1",
    plan: {
      schemaVersion: PLAN_SCHEMA_VERSION,
      planId: "plan-1",
      version: 1,
      status: "executing",
      title: "t",
      summary: "s",
      planningModel: { provider: "faux", modelId: "faux-model", thinkingLevel: "off" },
      steps: [
        {
          stepKey: "s0",
          stepId: "step-task",
          title: "t",
          description: "d",
          files: [],
          executionTarget: "subagent_background",
          risk: "low",
          riskReason: "r",
          effort: "small",
          verification: "v",
          dependsOn: [],
          status: "waiting_input",
          waitingReason: "agent_task",
          waitingTaskGroupId: "group-crash",
        },
        {
          stepKey: "s1",
          stepId: "step-parent",
          title: "t",
          description: "d",
          files: [],
          executionTarget: "parent",
          risk: "low",
          riskReason: "r",
          effort: "small",
          verification: "v",
          dependsOn: ["step-task"],
          status: "running",
          waitingReason: "",
        },
      ],
      createdAt: 1000,
      updatedAt: 1000,
    },
    deviations: [],
    updatedAt: 1000,
  };
  const entry = (data: unknown): SessionEntry =>
    ({ type: "custom", id: "e", parentId: null, timestamp: "t", customType: "pix-plan-v1", data }) as SessionEntry;
  const h = makeHarness();
  const c = makeController(h);
  await c.restoreFromHistory([entry(serializePlanRecord(snap, "plan_execution_started", 1))]);
  const s = c.getSnapshot();
  assertEqual(s.phase, "paused", "crash snapshot hydrates the plan to paused");
  assertEqual(s.plan!.status, "paused", "plan status paused");
  const taskStep = s.plan!.steps.find((st) => st.stepId === "step-task")!;
  const parentStep = s.plan!.steps.find((st) => st.stepId === "step-parent")!;
  assertEqual(taskStep.status, "interrupted", "task-linked step hydrates to interrupted");
  assertEqual(taskStep.waitingReason, "agent_task", "interrupted step keeps waitingReason agent_task");
  assertEqual(taskStep.waitingTaskGroupId, "group-crash", "interrupted step keeps waitingTaskGroupId");
  assertEqual(parentStep.status, "failed", "direct parent step hydrates to failed");
  assertEqual(parentStep.waitingReason, "", "parent step waiting fields cleared");

  // The interrupted step still owns its group: startExecution/retryStep
  // cannot bypass the two-phase consumption.
  const planId = s.planId!;
  const version = s.plan!.version;
  const start = await c.startExecution(planId, version);
  assert(!start.ok, "startExecution rejected while a hydrated interrupted step waits");
  assertEqual(start.reason, "background_task_waiting", "background_task_waiting reason");
  const retry = await c.retryStep(planId, version, parentStep.stepId);
  assert(!retry.ok, "retryStep rejected while an interrupted step owns its group");
  assertEqual(retry.reason, "another_step_active", "another_step_active reason");

  // Two-phase consumption with the SAME group works after the task completes.
  h.taskGroupResults.set("group-crash", { status: "completed", summary: "resumed and done" });
  const cont = await c.continuePlan(planId, version);
  assert(cont.ok, "hydrated interrupted step consumed via continuePlan");
  const s2 = c.getSnapshot();
  const consumed = s2.plan!.steps.find((st) => st.stepId === "step-task")!;
  assertEqual(consumed.status, "running", "completed group resumes the step to running");
  assertEqual(consumed.consumedTaskGroupId, "group-crash", "consumed fact persisted");
  assertEqual(h.confirmCalls.length, 1, "consumption confirmed exactly once");
  assertEqual(h.confirmCalls[0].groupId, "group-crash", "confirm targets the same group");
  assertEqual(h.releaseCalls.length, 0, "consumption never releases");
});

await run("1.4.2 hydration is idempotent for already-interrupted steps; never rewritten via failed", async () => {
  const snap: Parameters<typeof serializePlanRecord>[0] = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    phase: "paused",
    planId: "plan-1",
    plan: {
      schemaVersion: PLAN_SCHEMA_VERSION,
      planId: "plan-1",
      version: 1,
      status: "paused",
      title: "t",
      summary: "s",
      planningModel: { provider: "faux", modelId: "faux-model", thinkingLevel: "off" },
      steps: [
        {
          stepKey: "s0",
          stepId: "step-1",
          title: "t",
          description: "d",
          files: [],
          executionTarget: "subagent_background",
          risk: "low",
          riskReason: "r",
          effort: "small",
          verification: "v",
          dependsOn: [],
          status: "interrupted",
          waitingReason: "agent_task",
          waitingTaskGroupId: "group-1",
        },
      ],
      createdAt: 1000,
      updatedAt: 1000,
    },
    deviations: [],
    updatedAt: 1000,
  };
  const entry = (data: unknown): SessionEntry =>
    ({ type: "custom", id: "e", parentId: null, timestamp: "t", customType: "pix-plan-v1", data }) as SessionEntry;
  const h = makeHarness();
  const c = makeController(h);
  await c.restoreFromHistory([entry(serializePlanRecord(snap, "plan_hydrated", 1))]);
  const s = c.getSnapshot();
  assertEqual(s.phase, "paused", "paused plan stays paused");
  assertEqual(s.plan!.steps[0].status, "interrupted", "interrupted step stays interrupted");
  assertEqual(s.plan!.steps[0].waitingReason, "agent_task", "waitingReason agent_task kept");
  assertEqual(s.plan!.steps[0].waitingTaskGroupId, "group-1", "waitingTaskGroupId kept");
  assertEqual(s.plan!.steps[0].consumedTaskGroupId, undefined, "no consumed fact forged");
  assertEqual(h.confirmCalls.length, 0, "no confirm replay without consumedTaskGroupId");
});

await run("revision after interrupted hydration: old group released, old results never advance the new version", async () => {
  const snap: Parameters<typeof serializePlanRecord>[0] = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    phase: "paused",
    planId: "plan-1",
    plan: {
      schemaVersion: PLAN_SCHEMA_VERSION,
      planId: "plan-1",
      version: 1,
      status: "paused",
      title: "t",
      summary: "s",
      planningModel: { provider: "faux", modelId: "faux-model", thinkingLevel: "off" },
      steps: [
        {
          stepKey: "s0",
          stepId: "step-task",
          title: "t",
          description: "d",
          files: [],
          executionTarget: "subagent_background",
          risk: "low",
          riskReason: "r",
          effort: "small",
          verification: "v",
          dependsOn: [],
          status: "interrupted",
          waitingReason: "agent_task",
          waitingTaskGroupId: "group-old",
        },
        {
          stepKey: "s1",
          stepId: "step-parent",
          title: "t",
          description: "d",
          files: [],
          executionTarget: "parent",
          risk: "low",
          riskReason: "r",
          effort: "small",
          verification: "v",
          dependsOn: [],
          status: "failed",
          waitingReason: "",
          completionSummary: "blocked by the crash",
        },
      ],
      createdAt: 1000,
      updatedAt: 1000,
    },
    deviations: [],
    updatedAt: 1000,
  };
  const entry = (data: unknown): SessionEntry =>
    ({ type: "custom", id: "e", parentId: null, timestamp: "t", customType: "pix-plan-v1", data }) as SessionEntry;
  const h = makeHarness();
  const c = makeController(h);
  await c.restoreFromHistory([entry(serializePlanRecord(snap, "plan_hydrated", 1))]);
  let s = c.getSnapshot();
  assertEqual(s.plan!.steps[0].status, "interrupted", "task-linked step hydrated interrupted");
  assertEqual(s.plan!.steps[1].status, "failed", "direct parent step stays failed");
  const planId = s.planId!;

  // The user revises the plan instead of waiting: requestRevision itself
  // never releases; only the successful publish of version+1 releases the
  // old version's still-pending link (plan_revised).
  const revised = await c.requestRevision(planId, 1, "abandon the old approach");
  assert(revised.ok, "requestRevision ok");
  assertEqual(h.releaseCalls.length, 0, "requestRevision does not release the old link");
  const draft2 = makeDraft();
  draft2.basedOnVersion = 1;
  const submitted = await c.submitPlan({ ...draft2, generationId: revised.generationId! });
  assert(submitted.accepted, "successful revision accepted");
  s = c.getSnapshot();
  assertEqual(s.plan!.version, 2, "version 2 published");
  assertEqual(h.releaseCalls.length, 1, "successful revision releases exactly the old pending link");
  assertEqual(h.releaseCalls[0].groupId, "group-old", "released groupId");
  assertEqual(h.releaseCalls[0].reason, "plan_revised", "plan_revised reason");
  assertEqual(h.releaseCalls[0].link.version, 1, "release links the old version");
  assertEqual(h.releaseCalls[0].link.stepId, "step-task", "release links the old step");
  assertEqual(s.pendingTaskLinkReleases, undefined, "release intent cleared after success");
  assertEqual(s.plan!.steps[0].waitingTaskGroupId, undefined, "new version carries no old waiting group");

  // The old group completes later: it is never consumed into the new version;
  // it can only be delivered as an ordinary result elsewhere (service-level).
  h.taskGroupResults.set("group-old", { status: "completed", summary: "old work done" });
  const approved = await c.approve(planId, 2);
  assert(approved.ok, "approve v2 ok");
  const started = await c.startExecution(planId, 2);
  assert(started.ok, "startExecution v2 ok");
  const cont = await c.continuePlan(planId, 2);
  assert(!cont.ok, "continuePlan cannot consume the old group into the new version");
  assert(cont.reason!.includes("executing"), "new plan executing; no consumption path for the old group");
  assert(
    !h.confirmCalls.some((call) => call.groupId === "group-old"),
    "old group is never consumption-confirmed for the new plan",
  );
});

await run("pendingTaskLinkReleases: hydration replays intents at intent/service/clear crash points, then clears", async () => {
  const entry = (data: unknown): SessionEntry =>
    ({ type: "custom", id: "e", parentId: null, timestamp: "t", customType: "pix-plan-v1", data }) as SessionEntry;
  const makeSnap = (): Parameters<typeof serializePlanRecord>[0] => ({
    schemaVersion: PLAN_SCHEMA_VERSION,
    phase: "awaiting_approval",
    planId: "plan-1",
    plan: {
      schemaVersion: PLAN_SCHEMA_VERSION,
      planId: "plan-1",
      version: 2,
      status: "awaiting_approval",
      title: "t",
      summary: "s",
      planningModel: { provider: "faux", modelId: "faux-model", thinkingLevel: "off" },
      steps: [
        {
          stepKey: "s0",
          stepId: "step-1",
          title: "t",
          description: "d",
          files: [],
          executionTarget: "parent",
          risk: "low",
          riskReason: "r",
          effort: "small",
          verification: "v",
          dependsOn: [],
          status: "pending",
          waitingReason: "",
        },
      ],
      createdAt: 1000,
      updatedAt: 1000,
    },
    deviations: [],
    updatedAt: 1000,
  });

  // 1) Crash after the intent write, before the service release: hydration
  //    replays the intent, then clears it.
  const h1 = makeHarness();
  const c1 = makeController(h1);
  const snap1 = makeSnap();
  snap1.pendingTaskLinkReleases = [
    { groupId: "g-a", link: { planId: "plan-1", version: 1, stepId: "old-step" }, reason: "plan_revised" },
  ];
  await c1.restoreFromHistory([entry(serializePlanRecord(snap1, "plan_link_release_pending", 1))]);
  assert(
    h1.releaseCalls.some((call) => call.groupId === "g-a" && call.reason === "plan_revised" && call.link.version === 1),
    "intent-time crash: release replayed on hydration",
  );
  assertEqual(c1.getSnapshot().pendingTaskLinkReleases, undefined, "intent-time crash: intent cleared after replay");

  // 2) Crash mid-service-release (one intent already released, none cleared):
  //    hydration re-releases ALL idempotently, then clears.
  const h2 = makeHarness();
  const c2 = makeController(h2);
  const snap2 = makeSnap();
  snap2.pendingTaskLinkReleases = [
    { groupId: "g-b", link: { planId: "plan-1", version: 1, stepId: "old-step" }, reason: "plan_revised" },
    { groupId: "g-c", link: { planId: "plan-1", version: 1, stepId: "old-step" }, reason: "plan_cancelled" },
  ];
  h2.releaseCalls.push({ groupId: "g-b", link: { planId: "plan-1", version: 1, stepId: "old-step" }, reason: "plan_revised" });
  await c2.restoreFromHistory([entry(serializePlanRecord(snap2, "plan_link_release_pending", 1))]);
  assert(
    h2.releaseCalls.some((call) => call.groupId === "g-b" && call.reason === "plan_revised"),
    "service-time crash: already-released intent re-released idempotently",
  );
  assert(
    h2.releaseCalls.some((call) => call.groupId === "g-c" && call.reason === "plan_cancelled"),
    "service-time crash: not-yet-released intent released on hydration",
  );
  assertEqual(c2.getSnapshot().pendingTaskLinkReleases, undefined, "service-time crash: intent cleared after replay");

  // 3) Crash after the service release, before the clear snapshot: the
  //    persisted shape still carries the intent; hydration re-releases
  //    idempotently, then clears.
  const h3 = makeHarness();
  const c3 = makeController(h3);
  const snap3 = makeSnap();
  snap3.pendingTaskLinkReleases = [
    { groupId: "g-d", link: { planId: "plan-1", version: 1, stepId: "old-step" }, reason: "plan_cancelled" },
  ];
  await c3.restoreFromHistory([entry(serializePlanRecord(snap3, "plan_link_release_pending", 1))]);
  assert(
    h3.releaseCalls.some((call) => call.groupId === "g-d" && call.reason === "plan_cancelled"),
    "clear-time crash: release replayed on hydration",
  );
  assertEqual(c3.getSnapshot().pendingTaskLinkReleases, undefined, "clear-time crash: intent cleared after replay");
});

await run("Plan-linked task file changes: deviation detection on the waiting background step", async () => {
  const h = makeHarness();
  const c = makeController(h);
  const { planId, version, step } = await driveToBackgrounded(c, h);
  assert(h.linkedTaskListener !== undefined, "controller subscribed to Plan-linked task events");
  h.linkedTaskListener!({
    taskId: "t1",
    planId,
    version,
    stepId: step.stepId,
    change: { path: "src/undeclared.txt", toolCallId: "nested-fc", toolName: "edit", added: 1, removed: 0 },
    aggregate: { added: 1, removed: 0, files: 1, changes: [] },
  });
  await waitFor(() => c.getSnapshot().deviations.length === 1, 20000, "task file deviation recorded");
  const s = c.getSnapshot();
  assertEqual(s.deviations[0].type, "file_out_of_scope", "task file deviation type");
  assertEqual(s.deviations[0].stepId, step.stepId, "deviation bound to the waiting step");
  // Declared changes are clean.
  h.linkedTaskListener!({
    taskId: "t1",
    planId,
    version,
    stepId: step.stepId,
    change: { path: "src/a.txt", toolCallId: "nested-fc2", toolName: "edit", added: 0, removed: 1 },
    aggregate: { added: 0, removed: 1, files: 1, changes: [] },
  });
  await waitFor(() => c.getSnapshot().deviations.length === 1, 2000, "no second deviation");
  assertEqual(c.getSnapshot().deviations.length, 1, "declared task edit stays clean");
});

await run("dispose during planning keeps retryable state; dormant hydration; A8 executing hydration", async () => {
  // 1) dispose mid-generation
  const h = makeHarness();
  const c = makeController(h);
  await c.enterPlanning({ text: "plan" });
  await c.dispose("session_close");
  let s = c.getSnapshot();
  assertEqual(s.phase, "planning", "planning preserved on close");
  assert(s.generation !== undefined, "generation kept as retry credential");
  assertEqual(s.failure?.code, "cancelled", "retryable cancelled failure on close");
  assertEqual(s.failure?.retryable, true, "close failure retryable");
  assertEqual(s.failure?.generationId, s.generation!.generationId, "failure matches the kept generation");

  // 2) dormant hydration on a fresh controller
  const h2 = makeHarness();
  const c2 = makeController(h2);
  c2.restoreFromHistory(h.manager.getEntries());
  s = c2.getSnapshot();
  assertEqual(s.phase, "planning", "dormant planning restored");
  assertEqual(s.failure?.code, "cancelled", "dormant failure normalized");
  const oldGenerationId = s.generation!.generationId;
  const retried = await c2.retryGeneration(oldGenerationId);
  assert(retried.ok, "dormant retry ok");
  assert(retried.generationId !== oldGenerationId, "retry creates a fresh generationId");
  const late = await c2.submitPlan({ ...makeDraft(), generationId: oldGenerationId });
  assert(!late.accepted, "late submit with the old generationId is rejected");
  assertEqual(late.fieldErrors?.[0]?.path, "generationId", "generationId guard");

  // 3) A8 hydration: executing + running step -> paused + failed
  const h3 = makeHarness();
  const c3 = makeController(h3);
  await c3.enterPlanning({ text: "plan" });
  const genId = c3.getSnapshot().generation!.generationId;
  await c3.submitPlan({ ...makeDraft(), generationId: genId });
  const s3 = c3.getSnapshot();
  await c3.approve(s3.planId!, s3.plan!.version);
  await c3.startExecution(s3.planId!, s3.plan!.version);
  // The parent model started step 0 before the crash (running/waiting_input
  // steps are the ones hydrated to failed).
  await c3.updatePlanStep({
    planId: s3.planId!,
    version: s3.plan!.version,
    stepId: s3.plan!.steps[0].stepId,
    status: "running",
  });
  const planId = c3.getSnapshot().planId!;
  const h4 = makeHarness();
  const c4 = makeController(h4);
  c4.restoreFromHistory(h3.manager.getEntries());
  const s4 = c4.getSnapshot();
  assertEqual(s4.phase, "paused", "A8: executing hydrates to paused");
  assertEqual(s4.plan!.status, "paused", "plan status paused");
  assertEqual(s4.plan!.steps[0].status, "failed", "A8: current running step hydrates to failed");
  assertEqual(s4.plan!.steps[1].status, "pending", "A8: never-started steps stay pending");
  assertEqual(s4.planId, planId, "planId preserved through hydration");
});

await run("hydration: parent snapshot re-frozen so approve restores tools/model and useSessionModelAndRetry works", async () => {
  // A hydrated controller must re-freeze the parent model/thinking/tools from
  // the CURRENT session (the original freeze died with the old controller).
  // Without it, _restoreParentState is a no-op after approve (session stuck on
  // the planning allowlist/model) and useSessionModelAndRetry misreports
  // model_unavailable.
  const snap: Parameters<typeof serializePlanRecord>[0] = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    phase: "planning_failed",
    planId: "plan-1",
    plan: null,
    failure: {
      generationId: "gen-old",
      phase: "initial",
      code: "invalid_plan",
      message: "The plan generation failed.",
      fieldErrors: [],
      retryable: true,
      occurredAt: 1000,
    },
    deviations: [],
    updatedAt: 1000,
  };
  const entry = (data: unknown): SessionEntry =>
    ({ type: "custom", id: "e", parentId: null, timestamp: "t", customType: "pix-plan-v1", data }) as SessionEntry;

  // 1. Hydrated planning_failed -> retry -> submit -> approve: the parent tool
  //    surface (bash/edit/write) and model come back.
  const h2 = makeHarness({
    planningModel: { model: makeModel("plan-provider", "plan-model"), thinkingLevel: "low" },
  });
  const c2 = makeController(h2);
  await c2.restoreFromHistory([entry(serializePlanRecord(snap, "plan_generation_failed", 1))]);
  let s = c2.getSnapshot();
  assertEqual(s.phase, "planning_failed", "planning_failed hydrated");
  const retried = await c2.retryGeneration("gen-old");
  assert(retried.ok, "hydrated retry ok");
  assertEqual(h2.session.activeTools.join(","), PLAN_ALLOWLIST.join(","), "planning allowlist applied on the hydrated retry");
  assertEqual(h2.session.model?.id, "plan-model", "planning model applied on the hydrated retry");
  const submitted = await c2.submitPlan({ ...makeDraft(), generationId: retried.generationId! });
  assert(submitted.accepted, "hydrated retry submission accepted");
  assert(
    h2.session.activeTools.includes("bash") && h2.session.activeTools.includes("edit") && h2.session.activeTools.includes("write"),
    "parent tool surface restored after the hydrated submit",
  );
  assertEqual(h2.session.model?.id, "faux-model", "parent model restored after the hydrated submit");
  const planId = c2.getSnapshot().planId!;
  const approved = await c2.approve(planId, 1);
  assert(approved.ok, "approve ok after hydration");
  assert(
    h2.session.activeTools.includes("bash") && h2.session.activeTools.includes("edit") && h2.session.activeTools.includes("write"),
    "parent tool surface still restored after approve",
  );
  assertEqual(h2.session.model?.id, "faux-model", "parent model still restored after approve");

  // 2. useSessionModelAndRetry on a hydrated failure finds the re-frozen
  //    parent model instead of misreporting model_unavailable.
  const h3 = makeHarness({
    planningModel: { model: makeModel("plan-provider", "plan-model"), thinkingLevel: "low" },
  });
  const c3 = makeController(h3);
  await c3.restoreFromHistory([entry(serializePlanRecord(snap, "plan_generation_failed", 1))]);
  const sessionRetried = await c3.useSessionModelAndRetry("gen-old");
  assert(sessionRetried.ok, "useSessionModelAndRetry ok after hydration");
  s = c3.getSnapshot();
  assertEqual(s.failure, undefined, "no model_unavailable misreport after hydration");
  assertEqual(s.generation?.model.modelId, "faux-model", "use-session retry records the re-frozen parent model");
  assertEqual(s.generation?.model.provider, "faux", "use-session retry records the re-frozen provider");
  assertEqual(h3.session.modelCalls.at(-1)?.id, "faux-model", "the re-frozen parent model was actually applied");
});

await run("persistence: fork only inherits branch-path entries; gaps and corrupt envelopes handled", async () => {
  const snap1: Parameters<typeof serializePlanRecord>[0] = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    phase: "planning",
    planId: "plan-1",
    plan: null,
    deviations: [],
    updatedAt: 1000,
  };
  const snap2: Parameters<typeof serializePlanRecord>[0] = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    phase: "approved",
    planId: "plan-1",
    plan: {
      schemaVersion: PLAN_SCHEMA_VERSION,
      planId: "plan-1",
      version: 1,
      status: "approved",
      title: "t",
      summary: "s",
      planningModel: { provider: "faux", modelId: "faux-model", thinkingLevel: "off" },
      steps: [
        {
          stepKey: "s0",
          stepId: "step-1",
          title: "t",
          description: "d",
          files: [],
          executionTarget: "parent",
          risk: "low",
          riskReason: "r",
          effort: "small",
          verification: "v",
          dependsOn: [],
          status: "pending",
          waitingReason: "",
        },
      ],
      createdAt: 1000,
      updatedAt: 1000,
    },
    deviations: [],
    updatedAt: 1000,
  };
  const record1 = serializePlanRecord(snap1, "plan_generation_started", 1);
  const record2 = serializePlanRecord(snap2, "plan_approved", 2);
  const entry = (data: unknown): SessionEntry =>
    ({ type: "custom", id: "e", parentId: null, timestamp: "t", customType: "pix-plan-v1", data }) as SessionEntry;

  const full = rebuildPlanFromEntries([entry(record1), entry(record2)]);
  assert(full !== null, "full chain rebuilds");
  assertEqual(full!.snapshot.phase, "approved", "latest record wins on the same branch");
  assertEqual(full!.sequence, 2, "max contiguous sequence");

  const forkOnly = rebuildPlanFromEntries([entry(record1)]);
  assert(forkOnly !== null, "fork branch without the approval still rebuilds");
  assertEqual(forkOnly!.snapshot.phase, "planning", "fork does not inherit the approval outside its path");
  assertEqual(forkOnly!.sequence, 1, "fork sequence 1");

  const gap = rebuildPlanFromEntries([entry(record1), entry(serializePlanRecord(snap2, "plan_approved", 3))]);
  assertEqual(gap!.snapshot.phase, "planning", "gap stops the contiguous run");
  assertEqual(gap!.sequence, 1, "contiguous run ends before the gap");

  const corrupt = rebuildPlanFromEntries([entry({ ...record1, schemaVersion: 99 })]);
  assertEqual(corrupt, null, "corrupt envelope yields no rebuild");

  const empty = rebuildPlanFromEntries([]);
  assertEqual(empty, null, "no entries yields no rebuild");
});

await run("product events: full lifecycle emits §6.3 names in order", async () => {
  const h = makeHarness();
  const c = makeController(h);
  const { planId, version, step0, step1 } = await driveToExecuting(c, h);
  await c.updatePlanStep({ planId, version, stepId: step0.stepId, status: "running" });
  await c.updatePlanStep({
    planId,
    version,
    stepId: step0.stepId,
    status: "completed",
    completionSummary: "done",
    verificationResult: { status: "passed", summary: "ok" },
  });
  await c.updatePlanStep({ planId, version, stepId: step1.stepId, status: "running" });
  await c.updatePlanStep({
    planId,
    version,
    stepId: step1.stepId,
    status: "completed",
    completionSummary: "done",
    verificationResult: { status: "passed", summary: "ok" },
  });
  const names = eventNames(h);
  const expected = [
    "plan_mode_entered",
    "plan_generation_started",
    "plan_generation_succeeded",
    "plan_approved",
    "plan_execution_started",
    "plan_execution_completed",
  ];
  for (const name of expected) {
    assertIncludes(names, name, `§6.3 event ${name} recorded`);
  }
  const modeIndex = names.indexOf("plan_mode_entered");
  const completedIndex = names.indexOf("plan_execution_completed");
  assert(modeIndex !== -1 && completedIndex !== -1 && modeIndex < completedIndex, "events ordered by lifecycle");
});

await run("controller events: plan_state / plan_step / plan_deviation emitted", async () => {
  const h = makeHarness();
  const c = makeController(h);
  const events: string[] = [];
  c.onEvent((e) => events.push(e.type));
  await c.enterPlanning({ text: "plan" });
  const genId = c.getSnapshot().generation!.generationId;
  await c.submitPlan({ ...makeDraft(), generationId: genId });
  const s = c.getSnapshot();
  await c.approve(s.planId!, s.plan!.version);
  await c.startExecution(s.planId!, s.plan!.version);
  await c.updatePlanStep({ planId: s.planId!, version: s.plan!.version, stepId: s.plan!.steps[0].stepId, status: "running" });
  assert(events.includes("plan_state"), "plan_state emitted");
  assert(events.includes("plan_step"), "plan_step emitted");
});

await run("enterPlanning: completed plan can start a new plan with a fresh planId", async () => {
  const h = makeHarness();
  const c = makeController(h);
  const { planId, version, step0, step1 } = await driveToExecuting(c, h);
  await c.updatePlanStep({
    planId,
    version,
    stepId: step0.stepId,
    status: "running",
  });
  await c.updatePlanStep({
    planId,
    version,
    stepId: step0.stepId,
    status: "completed",
    completionSummary: "inspected",
    verificationResult: { status: "passed", summary: "ok" },
  });
  await c.updatePlanStep({
    planId,
    version,
    stepId: step1.stepId,
    status: "running",
  });
  await c.updatePlanStep({
    planId,
    version,
    stepId: step1.stepId,
    status: "completed",
    completionSummary: "refactored",
    verificationResult: { status: "passed", summary: "ok" },
  });
  assertEqual(c.getSnapshot().phase, "completed", "plan completed");
  const again = await c.enterPlanning({ text: "next plan" });
  assert(again.ok, "re-enter planning from completed");
  assert(c.getSnapshot().planId !== planId, "new planId assigned");
  assertEqual(c.getSnapshot().phase, "planning", "fresh planning phase");
});

await run("cancel: revising plan can be cancelled by version", async () => {
  const h = makeHarness();
  const c = makeController(h);
  const entered = await c.enterPlanning({ text: "plan" });
  await c.submitPlan({ ...makeDraft(), generationId: entered.generationId! });
  const planId = c.getSnapshot().planId!;
  await c.requestRevision(planId, 1, "revise it");
  const cancelled = await c.cancel({ planId, version: 1 });
  assert(cancelled.ok, "revising cancel ok");
  assertEqual(c.getSnapshot().phase, "cancelled", "revising cancel reaches cancelled");
});

await run("hydration: session_reopen keeps waiting_input(agent_task)", async () => {
  const h = makeHarness();
  const c = makeController(h);
  await driveToBackgrounded(c, h);
  await c.dispose("session_close");
  const h2 = makeHarness();
  const c2 = makeController(h2);
  await c2.restoreFromHistory(h.manager.getEntries(), { taskLinkHydration: "session_reopen" });
  const step = c2.getSnapshot().plan!.steps[0];
  assertEqual(step.status, "waiting_input", "same-app reopen keeps waiting_input");
  assertEqual(step.waitingReason, "agent_task", "waitingReason kept");
  assertEqual(step.waitingTaskGroupId, "group-1", "waitingTaskGroupId kept");
});

await run("hydration: consumed running step is not rewritten to failed", async () => {
  const snap: Parameters<typeof serializePlanRecord>[0] = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    phase: "executing",
    planId: "plan-consumed",
    plan: {
      schemaVersion: PLAN_SCHEMA_VERSION,
      planId: "plan-consumed",
      version: 1,
      status: "executing",
      title: "t",
      summary: "s",
      planningModel: { provider: "faux", modelId: "faux-model", thinkingLevel: "off" },
      steps: [
        {
          stepKey: "s0",
          stepId: "step-0",
          title: "t",
          description: "d",
          files: [],
          executionTarget: "subagent_background",
          risk: "low",
          riskReason: "r",
          effort: "small",
          verification: "v",
          dependsOn: [],
          status: "running",
          waitingReason: "",
          consumedTaskGroupId: "group-consumed",
          consumedTaskSummary: "done",
        },
      ],
      createdAt: 1,
      updatedAt: 1,
    },
    deviations: [],
    updatedAt: 1,
  };
  const h = makeHarness();
  h.manager.appendCustomEntry("pix-plan-v1", serializePlanRecord(snap, "plan_step_running", 1));
  const c = makeController(h);
  await c.restoreFromHistory(h.manager.getEntries());
  const step = c.getSnapshot().plan!.steps[0];
  assertEqual(step.status, "running", "consumed running step stays running");
  assertEqual(step.consumedTaskGroupId, "group-consumed", "consumed id kept");
  assertEqual(c.getSnapshot().phase, "paused", "executing hydrates to paused");
});

await run("startExecution: failed step blocks resume", async () => {
  const h = makeHarness();
  const c = makeController(h);
  const { planId, version, step0 } = await driveToExecuting(c, h);
  await c.updatePlanStep({ planId, version, stepId: step0.stepId, status: "running" });
  await c.updatePlanStep({ planId, version, stepId: step0.stepId, status: "failed", completionSummary: "broke" });
  const started = await c.startExecution(planId, version);
  assert(!started.ok, "startExecution rejected while a failed step is pending");
  assertEqual(started.reason, "failed_step_pending", "failed_step_pending");
  const continued = await c.continuePlan(planId, version);
  assert(!continued.ok, "continuePlan rejected while a failed step is pending");
  assertEqual(continued.reason, "failed_step_pending", "continuePlan failed_step_pending");
});

await run("plan-path cancel: late settle after re-enter does not fail the new generation", async () => {
  const h = makeHarness();
  const c = makeController(h);
  const entered = await c.enterPlanning({ text: "plan" });
  await c.submitPlan({ ...makeDraft(), generationId: entered.generationId! });
  const planId = c.getSnapshot().planId!;
  await c.requestRevision(planId, 1, "revise it");
  h.session.isStreaming = true;
  const cancelled = await c.cancel({ planId, version: 1 });
  assert(cancelled.ok, "revising cancel ok");
  assertEqual(c.getSnapshot().phase, "cancelled", "revising cancel reaches cancelled");
  h.session.isStreaming = false;
  const again = await c.enterPlanning({ text: "next plan" });
  assert(again.ok, "re-enter planning after plan-path cancel");
  assertEqual(c.getSnapshot().phase, "planning", "fresh planning phase");
  h.session.isStreaming = true;
  h.session.emitTurnSettled("stop");
  assertEqual(c.getSnapshot().phase, "planning", "stale settle leaves the new generation running");
  assertEqual(c.getSnapshot().failure, undefined, "no invalid_plan from the aborted turn");
});

await run("plan-path cancel from executing: late settle does not fail a re-entered generation", async () => {
  const h = makeHarness();
  const c = makeController(h);
  const { planId, version } = await driveToExecuting(c, h);
  h.session.isStreaming = true;
  const cancelled = await c.cancel({ planId, version });
  assert(cancelled.ok, "executing cancel ok");
  h.session.isStreaming = false;
  const again = await c.enterPlanning({ text: "next plan" });
  assert(again.ok, "re-enter after executing cancel");
  h.session.isStreaming = true;
  h.session.emitTurnSettled("stop");
  assertEqual(c.getSnapshot().phase, "planning", "stale execution settle does not fail the new generation");
  assertEqual(c.getSnapshot().failure, undefined, "no invalid_plan from the aborted execution turn");
});

// ============================================================================

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
