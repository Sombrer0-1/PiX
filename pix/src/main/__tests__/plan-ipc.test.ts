/**
 * Plan IPC tests (PiX 1.4.0, P2).
 *
 * Covers the §4.9 PlanCommand contract end-to-end with an INJECTABLE IPC
 * adapter (pure Node, no Electron runtime): every PlanCommand type, the
 * existing {success,data?,error,code?} PixApi envelope (data-bearing commands
 * carry data, data-less commands omit it), stale generation/version rejection
 * and plan-event forwarding (plan_state / plan_step / plan_deviation).
 *
 * IPC harness rule (design plan §3): the test registers the REAL production
 * handlers from ipc-plan-adapters.ts on a top-level-imported injectable
 * IpcMainLike/WebContentsLike adapter; production registerIpcHandlers passes
 * the real ipcMain / win.webContents. ipc-handlers.ts itself cannot be
 * imported from pure Node (its electron import chain, including
 * file-dialogs.ts, fails to load outside the Electron runtime), so the
 * plan/agent-task registration and dispatch were extracted into pure modules
 * (ipc-plan-adapters.ts / ipc-agent-task-adapters.ts) that the IPC tests
 * import directly - no mirror, no lockstep. The command semantics are
 * exercised against the REAL PlanController.
 *
 * Run with: npm exec tsx -- src/main/__tests__/plan-ipc.test.ts
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentExecutionMode, AgentSession, SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  ClipboardImage,
  PixCommandResult,
  PlanEvent,
  PlanRuntimeSnapshot,
  ProjectLocation,
  ThinkingLevel,
} from "../../shared/types.js";
import { PLAN_SCHEMA_VERSION, isPlanRuntimeSnapshot, type PlanDeviation, type PlanStep } from "../../shared/plan-types.js";
import type { ProjectExecutionContext } from "../execution-context.js";
import { PlanController } from "../plan/plan-controller.js";
import type {
  PlanControllerContext,
  PlanStepExecutionLink,
  StepDelegateResult,
} from "../plan/plan-controller.js";
import type { SubmitUserPlanParams, UpdatePlanStepParams } from "../plan/plan-deviation.js";
import {
  registerPlanIpcHandlers,
  resyncPlanEventForwarding,
  subscribePlanEventForwarding,
  type IpcMainLike,
  type WebContentsLike,
} from "../ipc-plan-adapters.js";

// ============================================================================
// Test harness (matches plan-controller.test.ts / plan-types.test.ts style)
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

const WORKSPACE = mkdtempSync(join(tmpdir(), "pix-plan-ipc-ws-"));
mkdirSync(join(WORKSPACE, "src"), { recursive: true });
writeFileSync(join(WORKSPACE, "src", "a.txt"), "hello", "utf-8");

function makeLocation(): ProjectLocation {
  return {
    path: WORKSPACE,
    physicalPath: WORKSPACE,
    name: "plan-ipc-ws",
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
// Fake session / manager (duck-typed AgentSession, same as plan-controller.test.ts)
// ============================================================================

interface CustomMessageRecord {
  customType: string;
  content: string;
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
    message: { customType: string; content: string; display: boolean },
    options?: { triggerTurn?: boolean },
  ): Promise<void> {
    this.customMessages.push({
      customType: message.customType,
      content: typeof message.content === "string" ? message.content : "",
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

interface Harness {
  session: FakeSession;
  manager: FakeSessionManager;
  executionMode: AgentExecutionMode;
  promptCalls: Array<{ text: string; filePaths?: string[]; images?: ClipboardImage[] }>;
  delegated: Array<{ step: PlanStep; link: PlanStepExecutionLink; presentation: string }>;
  delegateResult: StepDelegateResult | undefined;
}

function makeHarness(overrides: Partial<Harness> = {}): Harness {
  const harness: Harness = {
    session: new FakeSession(),
    manager: new FakeSessionManager(),
    executionMode: "approval",
    promptCalls: [],
    delegated: [],
    delegateResult: undefined,
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
    resolvePlanningModel: () => ({ model: makeModel(), thinkingLevel: "high" }),
    promptPlanningRequest: async (request) => {
      h.promptCalls.push({ text: request.text, filePaths: request.filePaths, images: request.images });
    },
    requestUserInput: async () => ({ id: "req", cancelled: true, answers: {} }),
    recordProductEvent: () => {},
    delegateSubagentStep: async (step, link, presentation) => {
      h.delegated.push({ step, link, presentation });
      return h.delegateResult ?? { stepId: step.stepId, status: "result", summary: "subagent done" };
    },
  };
}

function makeController(h: Harness): PlanController {
  return new PlanController(makeContext(h));
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

/** s0 -> (s1, s2) parallel: lets a paused plan still hold a runnable pending step. */
function makeBranchDraft(): SubmitUserPlanParams {
  const base = makeDraft();
  base.steps.push({
    stepKey: "s2",
    title: "Verify the refactor",
    description: "Run the test suite and confirm the widget behaves.",
    files: [{ path: "src/", operation: "read" }],
    executionTarget: "parent",
    risk: "low",
    riskReason: "Read-only verification.",
    effort: "small",
    verification: "npm test passes.",
    dependsOn: ["s0"],
  });
  return base;
}

/** Enter -> submit -> awaiting_approval with the given draft. */
async function driveToAwaitingApproval(
  c: PlanController,
  draft: SubmitUserPlanParams = makeDraft(),
): Promise<{ planId: string; version: number }> {
  const entered = await c.enterPlanning({ text: "plan this work" });
  assert(entered.ok, "enterPlanning ok");
  const submitted = await c.submitPlan({ ...draft, generationId: entered.generationId! });
  assert(submitted.accepted, "draft accepted");
  const snapshot = c.getSnapshot();
  return { planId: snapshot.planId!, version: snapshot.plan!.version };
}

/** Enter -> submit -> approve -> startExecution with a parent step running. */
async function driveToExecuting(
  c: PlanController,
  h: Harness,
  draft: SubmitUserPlanParams = makeDraft(),
): Promise<{ planId: string; version: number; step0: PlanStep; step1: PlanStep }> {
  const { planId, version } = await driveToAwaitingApproval(c, draft);
  const snapshot = c.getSnapshot();
  const step0 = snapshot.plan!.steps[0];
  const step1 = snapshot.plan!.steps[1];
  const approved = await c.approve(planId, version);
  assert(approved.ok, "approve ok");
  const started = await c.startExecution(planId, version);
  assert(started.ok, "startExecution ok");
  return { planId, version, step0, step1 };
}

// ============================================================================
// Injectable IPC adapter (pure Node; REAL handlers imported from
// ipc-plan-adapters.ts - no mirror, no lockstep)
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
}

// ============================================================================
// Tests
// ============================================================================

await run("registration: invalid commands rejected with invalid_plan_command", async () => {
  const h = makeHarness();
  const c = makeController(h);
  const ipc = new FakeIpcMain();
  registerPlanIpcHandlers(ipc, () => c);

  const bogus = (await ipc.invoke("plan-command", { type: "bogus" })) as PixCommandResult;
  const bogusFailure = assertFailure(bogus, "unknown type rejected");
  assertEqual(bogusFailure.code, "invalid_plan_command", "invalid_plan_command code");
  assert(bogusFailure.error.includes("Invalid plan command"), "error message present");

  const missingId = (await ipc.invoke("plan-command", { type: "retry_generation" })) as PixCommandResult;
  assertFailure(missingId, "missing generationId rejected");

  const badVersion = (await ipc.invoke("plan-command", { type: "approve", planId: "p", version: "1" })) as PixCommandResult;
  assertFailure(badVersion, "non-numeric version rejected");

  const noCancelRef = (await ipc.invoke("plan-command", { type: "cancel", planId: "p" })) as PixCommandResult;
  assertFailure(noCancelRef, "cancel without generationId/version rejected");

  const attachmentsWithoutText = (await ipc.invoke("plan-command", {
    type: "enter_planning",
    filePaths: ["/tmp/a.txt"],
  })) as PixCommandResult;
  assertFailure(attachmentsWithoutText, "dormant-retry attachments without requestText rejected");

  const badSource = (await ipc.invoke("plan-command", {
    type: "enter_planning",
    requestText: "plan",
    source: "bogus",
  })) as PixCommandResult;
  assertFailure(badSource, "unknown source rejected");

  const badFeedback = (await ipc.invoke("plan-command", {
    type: "request_revision",
    planId: "p",
    version: 1,
    feedback: 42,
  })) as PixCommandResult;
  assertFailure(badFeedback, "non-string feedback rejected");

  const missingStep = (await ipc.invoke("plan-command", { type: "skip_step", planId: "p", version: 1 })) as PixCommandResult;
  assertFailure(missingStep, "skip_step without stepId rejected");
});

await run("plan_unavailable when the bridge exposes no controller", async () => {
  const ipc = new FakeIpcMain();
  registerPlanIpcHandlers(ipc, () => null);
  const result = (await ipc.invoke("plan-command", { type: "get_snapshot" })) as PixCommandResult;
  const failure = assertFailure(result, "envelope failure");
  assertEqual(failure.code, "plan_unavailable", "plan_unavailable code");
  assert(failure.error.length > 0, "error message present");
});

await run("enter_planning: success envelope + user request assembly", async () => {
  const h = makeHarness();
  const c = makeController(h);
  const ipc = new FakeIpcMain();
  registerPlanIpcHandlers(ipc, () => c);

  const result = (await ipc.invoke("plan-command", {
    type: "enter_planning",
    requestText: "build me a plan",
    filePaths: [join(WORKSPACE, "src", "a.txt")],
    images: [{ mimeType: "image/png", base64: "aGVsbG8=" }],
    source: "session",
  })) as PixCommandResult;
  assertEqual(result.success, true, "enter_planning succeeds");
  assert(!("data" in result), "data-less command omits data on success");

  const snapshot = c.getSnapshot();
  assertEqual(snapshot.phase, "planning", "snapshot phase planning");
  assert(snapshot.planId !== null, "planId assigned on first enter");
  assertEqual(h.promptCalls.length, 1, "promptPlanningRequest called exactly once");
  assertEqual(h.promptCalls[0].text, "build me a plan", "requestText is the user message");
  assertEqual(h.promptCalls[0].filePaths?.length, 1, "filePaths flow through");
  assertEqual(h.promptCalls[0].images?.length, 1, "images flow through");
});

await run("enter_planning: empty request, duplicate entry, dormant retry", async () => {
  // Empty request text is rejected by the controller (first entry requires
  // non-empty text) without any prompt.
  const h = makeHarness();
  const c = makeController(h);
  const ipc = new FakeIpcMain();
  registerPlanIpcHandlers(ipc, () => c);

  const empty = (await ipc.invoke("plan-command", { type: "enter_planning", requestText: "   " })) as PixCommandResult;
  const emptyFailure = assertFailure(empty, "empty request rejected");
  assertEqual(emptyFailure.code, "empty_request", "empty_request code");
  assertEqual(emptyFailure.error, "empty_request", "error carries the controller reason");
  assertEqual(h.promptCalls.length, 0, "no prompt written");

  // Duplicate entry while a generation is live.
  const first = (await ipc.invoke("plan-command", { type: "enter_planning", requestText: "plan one" })) as PixCommandResult;
  assertEqual(first.success, true, "first entry succeeds");
  const second = (await ipc.invoke("plan-command", { type: "enter_planning", requestText: "plan two" })) as PixCommandResult;
  const secondFailure = assertFailure(second, "second entry rejected");
  assertEqual(secondFailure.code, "generation_in_progress", "generation_in_progress code");

  // Dormant retry: after a failed generation, enter_planning without
  // requestText is allowed (resumes with a pix-plan-retry message).
  h.session.emitTurnSettled("stop");
  assertEqual(c.getSnapshot().phase, "planning_failed", "turn settled -> planning_failed");
  const dormant = (await ipc.invoke("plan-command", { type: "enter_planning" })) as PixCommandResult;
  assertEqual(dormant.success, true, "dormant retry succeeds without requestText");
  assertEqual(c.getSnapshot().phase, "planning", "dormant retry restores planning");
});

await run("generation failure: retry / use-session-model / regenerate", async () => {
  // retry_generation
  const h1 = makeHarness();
  const c1 = makeController(h1);
  const ipc1 = new FakeIpcMain();
  registerPlanIpcHandlers(ipc1, () => c1);
  await ipc1.invoke("plan-command", { type: "enter_planning", requestText: "make a plan" });
  h1.session.emitTurnSettled("stop");
  const failureId = c1.getSnapshot().failure!.generationId;
  const retried = (await ipc1.invoke("plan-command", { type: "retry_generation", generationId: failureId })) as PixCommandResult;
  assertEqual(retried.success, true, "retry_generation succeeds");
  assertEqual(c1.getSnapshot().phase, "planning", "retry restores planning");

  // use_session_model_and_retry
  const h2 = makeHarness();
  const c2 = makeController(h2);
  const ipc2 = new FakeIpcMain();
  registerPlanIpcHandlers(ipc2, () => c2);
  await ipc2.invoke("plan-command", { type: "enter_planning", requestText: "make a plan" });
  h2.session.emitTurnSettled("stop");
  const failureId2 = c2.getSnapshot().failure!.generationId;
  const withSession = (await ipc2.invoke("plan-command", {
    type: "use_session_model_and_retry",
    generationId: failureId2,
  })) as PixCommandResult;
  assertEqual(withSession.success, true, "use_session_model_and_retry succeeds");

  // regenerate_plan (concise)
  const h3 = makeHarness();
  const c3 = makeController(h3);
  const ipc3 = new FakeIpcMain();
  registerPlanIpcHandlers(ipc3, () => c3);
  await ipc3.invoke("plan-command", { type: "enter_planning", requestText: "make a plan" });
  h3.session.emitTurnSettled("length");
  const failureId3 = c3.getSnapshot().failure!.generationId;
  const regenerated = (await ipc3.invoke("plan-command", {
    type: "regenerate_plan",
    generationId: failureId3,
    concise: true,
  })) as PixCommandResult;
  assertEqual(regenerated.success, true, "regenerate_plan succeeds");
  const concise = c3.getSnapshot().generation!.concise;
  assertEqual(concise, true, "concise flag reaches the generation");
});

await run("stale generation rejected (retry after failure, and after cancel)", async () => {
  const h = makeHarness();
  const c = makeController(h);
  const ipc = new FakeIpcMain();
  registerPlanIpcHandlers(ipc, () => c);
  await ipc.invoke("plan-command", { type: "enter_planning", requestText: "make a plan" });
  h.session.emitTurnSettled("stop");
  const failureId = c.getSnapshot().failure!.generationId;
  const planId = c.getSnapshot().planId!;

  const staleRetry = (await ipc.invoke("plan-command", {
    type: "retry_generation",
    generationId: "wrong-generation",
  })) as PixCommandResult;
  const staleRetryFailure = assertFailure(staleRetry, "retry with a stale generationId rejected");
  assertEqual(staleRetryFailure.code, "stale_generation", "stale_generation code");

  // Cancel the failed generation by generation ref; the token is gone.
  const cancelled = (await ipc.invoke("plan-command", {
    type: "cancel",
    planId,
    generationId: failureId,
  })) as PixCommandResult;
  assertEqual(cancelled.success, true, "cancel by generation ref succeeds");
  assertEqual(c.getSnapshot().phase, "cancelled", "generation cancel -> cancelled phase");

  const afterCancel = (await ipc.invoke("plan-command", {
    type: "retry_generation",
    generationId: failureId,
  })) as PixCommandResult;
  const afterCancelFailure = assertFailure(afterCancel, "retry after cancel rejected");
  assertEqual(afterCancelFailure.code, "stale_generation", "stale_generation after cancel");
});

await run("approve / start_execution: success, phase gates, stale version and plan", async () => {
  const h = makeHarness();
  const c = makeController(h);
  const ipc = new FakeIpcMain();
  registerPlanIpcHandlers(ipc, () => c);
  const { planId, version } = await driveToAwaitingApproval(c);

  const approved = (await ipc.invoke("plan-command", { type: "approve", planId, version })) as PixCommandResult;
  assertEqual(approved.success, true, "approve succeeds");
  assertEqual(c.getSnapshot().phase, "approved", "phase approved");

  const doubleApprove = (await ipc.invoke("plan-command", { type: "approve", planId, version })) as PixCommandResult;
  const doubleApproveFailure = assertFailure(doubleApprove, "second approve rejected");
  assert(doubleApproveFailure.code!.includes("cannot approve"), "phase gate reason as code");

  const staleVersion = (await ipc.invoke("plan-command", { type: "approve", planId, version: version + 1 })) as PixCommandResult;
  const staleVersionFailure = assertFailure(staleVersion, "stale version rejected");
  assertEqual(staleVersionFailure.code, "stale_version", "stale_version code");

  const stalePlan = (await ipc.invoke("plan-command", { type: "approve", planId: "other-plan", version })) as PixCommandResult;
  const stalePlanFailure = assertFailure(stalePlan, "stale plan id rejected");
  assertEqual(stalePlanFailure.code, "stale_plan", "stale_plan code");

  const started = (await ipc.invoke("plan-command", { type: "start_execution", planId, version })) as PixCommandResult;
  assertEqual(started.success, true, "start_execution succeeds");
  assertEqual(c.getSnapshot().phase, "executing", "phase executing");
});

await run("start_execution: read-only gate keeps the state", async () => {
  const h = makeHarness({ executionMode: "read-only" });
  const c = makeController(h);
  const ipc = new FakeIpcMain();
  registerPlanIpcHandlers(ipc, () => c);
  const { planId, version } = await driveToAwaitingApproval(c);

  const approved = (await ipc.invoke("plan-command", { type: "approve", planId, version })) as PixCommandResult;
  assertEqual(approved.success, true, "approve allowed in read-only");
  const started = (await ipc.invoke("plan-command", { type: "start_execution", planId, version })) as PixCommandResult;
  const startedFailure = assertFailure(started, "start_execution rejected in read-only");
  assertEqual(startedFailure.code, "read_only", "read_only code");
  assertEqual(c.getSnapshot().phase, "approved", "state stays approved");
});

await run("request_revision / return_previous_version: success, gates and stale refs", async () => {
  const h = makeHarness();
  const c = makeController(h);
  const ipc = new FakeIpcMain();
  registerPlanIpcHandlers(ipc, () => c);
  const { planId, version } = await driveToAwaitingApproval(c);

  const emptyFeedback = (await ipc.invoke("plan-command", {
    type: "request_revision",
    planId,
    version,
    feedback: "   ",
  })) as PixCommandResult;
  const emptyFeedbackFailure = assertFailure(emptyFeedback, "empty feedback rejected");
  assertEqual(emptyFeedbackFailure.code, "empty_feedback", "empty_feedback code");

  const revised = (await ipc.invoke("plan-command", {
    type: "request_revision",
    planId,
    version,
    feedback: "Split the refactor into smaller steps.",
    stepKey: "s1",
  })) as PixCommandResult;
  assertEqual(revised.success, true, "request_revision succeeds");
  assertEqual(c.getSnapshot().phase, "revising", "phase revising");

  const returned = (await ipc.invoke("plan-command", {
    type: "return_previous_version",
    planId,
    baseVersion: version,
  })) as PixCommandResult;
  assertEqual(returned.success, true, "return_previous_version succeeds");
  assertEqual(c.getSnapshot().phase, "awaiting_approval", "base restored to awaiting_approval");

  const doubleReturn = (await ipc.invoke("plan-command", {
    type: "return_previous_version",
    planId,
    baseVersion: version,
  })) as PixCommandResult;
  const doubleReturnFailure = assertFailure(doubleReturn, "second return rejected");
  assertEqual(doubleReturnFailure.code, "not_in_revision", "not_in_revision code");

  const staleReturn = (await ipc.invoke("plan-command", {
    type: "return_previous_version",
    planId,
    baseVersion: version + 1,
  })) as PixCommandResult;
  const staleReturnFailure = assertFailure(staleReturn, "stale baseVersion rejected");
  assertEqual(staleReturnFailure.code, "stale_version", "stale_version code");
});

await run("cancel by version ref: awaiting_approval -> cancelled", async () => {
  const h = makeHarness();
  const c = makeController(h);
  const ipc = new FakeIpcMain();
  registerPlanIpcHandlers(ipc, () => c);
  const { planId, version } = await driveToAwaitingApproval(c);

  const cancelled = (await ipc.invoke("plan-command", { type: "cancel", planId, version })) as PixCommandResult;
  assertEqual(cancelled.success, true, "cancel by version ref succeeds");
  const snapshot = c.getSnapshot();
  assertEqual(snapshot.phase, "cancelled", "phase cancelled");
  assertEqual(snapshot.plan!.status, "cancelled", "plan status cancelled");
  assertEqual(snapshot.plan!.steps.every((step) => step.status === "cancelled"), true, "steps cancelled");

  const doubleCancel = (await ipc.invoke("plan-command", { type: "cancel", planId, version })) as PixCommandResult;
  assertFailure(doubleCancel, "second cancel rejected");
});

await run("skip_step: phase gate, dependent rejected, non-pending rejected", async () => {
  // skip is only legal while executing/paused: from awaiting_approval the
  // controller rejects, because skipping before approval would strand the
  // plan in approved with no runnable step (start_execution -> no_runnable_step
  // forever, and approved has no completion exit).
  const h1 = makeHarness();
  const c1 = makeController(h1);
  const ipc1 = new FakeIpcMain();
  registerPlanIpcHandlers(ipc1, () => c1);
  const { planId: planId1, version: version1 } = await driveToAwaitingApproval(c1);
  const gatedStep = c1.getSnapshot().plan!.steps[1];
  const gated = (await ipc1.invoke("plan-command", {
    type: "skip_step",
    planId: planId1,
    version: version1,
    stepId: gatedStep.stepId,
  })) as PixCommandResult;
  const gatedFailure = assertFailure(gated, "skip from awaiting_approval rejected");
  assert(gatedFailure.code!.includes("cannot skip"), "phase gate reason as code");
  assertEqual(c1.getSnapshot().plan!.steps[1].status, "pending", "step untouched");

  // During execution: step0 has a dependent (step1), so skipping it must be
  // rejected; the independent pending leaf step1 is skippable.
  const h2 = makeHarness();
  const c2 = makeController(h2);
  const ipc2 = new FakeIpcMain();
  registerPlanIpcHandlers(ipc2, () => c2);
  const { planId, version, step1 } = await driveToExecuting(c2, h2);
  const rootStep = c2.getSnapshot().plan!.steps[0];

  const skipRoot = (await ipc2.invoke("plan-command", {
    type: "skip_step",
    planId,
    version,
    stepId: rootStep.stepId,
  })) as PixCommandResult;
  const skipRootFailure = assertFailure(skipRoot, "skip with dependents rejected");
  assert(skipRootFailure.code!.includes("dependent"), "dependent step reason");

  const skipped = (await ipc2.invoke("plan-command", {
    type: "skip_step",
    planId,
    version,
    stepId: step1.stepId,
  })) as PixCommandResult;
  assertEqual(skipped.success, true, "pending leaf step skipped");
  assertEqual(c2.getSnapshot().plan!.steps[1].status, "skipped", "step status skipped");

  const skipAgain = (await ipc2.invoke("plan-command", {
    type: "skip_step",
    planId,
    version,
    stepId: step1.stepId,
  })) as PixCommandResult;
  const skipAgainFailure = assertFailure(skipAgain, "non-pending step cannot be skipped");
  assertEqual(skipAgainFailure.code, "step_not_pending", "step_not_pending code");
});

await run("retry_step: phase gate, unknown step and failed-step retry", async () => {
  // Phase gate: retry_step from awaiting_approval is rejected before the
  // step lookup.
  const h1 = makeHarness();
  const c1 = makeController(h1);
  const ipc1 = new FakeIpcMain();
  registerPlanIpcHandlers(ipc1, () => c1);
  const { planId: planId1, version: version1 } = await driveToAwaitingApproval(c1);
  const gated = (await ipc1.invoke("plan-command", {
    type: "retry_step",
    planId: planId1,
    version: version1,
    stepId: "any-step",
  })) as PixCommandResult;
  const gatedFailure = assertFailure(gated, "retry from awaiting_approval rejected");
  assert(gatedFailure.code!.includes("cannot retry"), "phase gate reason as code");

  // Failed step retry: failed -> running via the user retry special case;
  // unknown step ids are rejected from the paused state.
  const h2 = makeHarness();
  const c2 = makeController(h2);
  const ipc2 = new FakeIpcMain();
  registerPlanIpcHandlers(ipc2, () => c2);
  const { planId: planId2, version: version2, step0 } = await driveToExecuting(c2, h2);
  const running = await c2.updatePlanStep({ planId: planId2, version: version2, stepId: step0.stepId, status: "running" });
  assert(running.accepted, "step running accepted");
  const failed = await c2.updatePlanStep({
    planId: planId2,
    version: version2,
    stepId: step0.stepId,
    status: "failed",
    completionSummary: "blocked",
  });
  assert(failed.accepted, "step failure accepted");
  assertEqual(c2.getSnapshot().phase, "paused", "failed step pauses the plan");

  const unknown = (await ipc2.invoke("plan-command", {
    type: "retry_step",
    planId: planId2,
    version: version2,
    stepId: "no-such-step",
  })) as PixCommandResult;
  const unknownFailure = assertFailure(unknown, "unknown step rejected");
  assertEqual(unknownFailure.code, "unknown_step", "unknown_step code");

  const retried = (await ipc2.invoke("plan-command", {
    type: "retry_step",
    planId: planId2,
    version: version2,
    stepId: step0.stepId,
  })) as PixCommandResult;
  assertEqual(retried.success, true, "retry_step succeeds");
  assertEqual(c2.getSnapshot().phase, "executing", "retry resumes executing");
  assertEqual(c2.getSnapshot().plan!.steps[0].status, "running", "failed step back to running");
});

await run("continue_plan: phase gate and resume after a pause", async () => {
  // continue_plan from awaiting_approval is rejected.
  const h1 = makeHarness();
  const c1 = makeController(h1);
  const ipc1 = new FakeIpcMain();
  registerPlanIpcHandlers(ipc1, () => c1);
  const { planId: planId1, version: version1 } = await driveToAwaitingApproval(c1);
  const gated = (await ipc1.invoke("plan-command", {
    type: "continue_plan",
    planId: planId1,
    version: version1,
  })) as PixCommandResult;
  const gatedFailure = assertFailure(gated, "continue from awaiting_approval rejected");
  assert(gatedFailure.code!.includes("cannot continue"), "phase gate reason as code");

  // Branch draft: s0 completes, s1 fails -> paused. continue_plan must not
  // skip the failed step; retry_step is the resume path.
  const h2 = makeHarness();
  const c2 = makeController(h2);
  const ipc2 = new FakeIpcMain();
  registerPlanIpcHandlers(ipc2, () => c2);
  const { planId: planId2, version: version2 } = await driveToAwaitingApproval(c2, makeBranchDraft());
  const snapshot = c2.getSnapshot();
  const s0 = snapshot.plan!.steps[0];
  const s1 = snapshot.plan!.steps[1];
  await c2.approve(planId2, version2);
  await c2.startExecution(planId2, version2);
  assertEqual(await c2.updatePlanStep({ planId: planId2, version: version2, stepId: s0.stepId, status: "running" }).then((r) => r.accepted), true, "s0 running accepted");
  assertEqual(
    await c2
      .updatePlanStep({
        planId: planId2,
        version: version2,
        stepId: s0.stepId,
        status: "completed",
        completionSummary: "seams identified",
        verificationResult: { status: "passed", summary: "documented" },
      })
      .then((r) => r.accepted),
    true,
    "s0 completed accepted",
  );
  assertEqual(await c2.updatePlanStep({ planId: planId2, version: version2, stepId: s1.stepId, status: "running" }).then((r) => r.accepted), true, "s1 running accepted");
  assertEqual(
    await c2.updatePlanStep({ planId: planId2, version: version2, stepId: s1.stepId, status: "failed", completionSummary: "blocked" }).then((r) => r.accepted),
    true,
    "s1 failure accepted",
  );
  assertEqual(c2.getSnapshot().phase, "paused", "s1 failure pauses the plan");

  const resumed = (await ipc2.invoke("plan-command", {
    type: "continue_plan",
    planId: planId2,
    version: version2,
  })) as PixCommandResult;
  const continueFailure = assertFailure(resumed, "continue_plan rejected while a failed step is pending");
  assertEqual(continueFailure.code, "failed_step_pending", "failed_step_pending code");
  assertEqual(c2.getSnapshot().phase, "paused", "phase stays paused until retry_step");
});

await run("get_snapshot: data envelope + guard-valid snapshot", async () => {
  const h = makeHarness();
  const c = makeController(h);
  const ipc = new FakeIpcMain();
  registerPlanIpcHandlers(ipc, () => c);

  const before = (await ipc.invoke("plan-command", { type: "get_snapshot" })) as PixCommandResult<PlanRuntimeSnapshot | undefined>;
  assertEqual(before.success, true, "get_snapshot succeeds before any plan");
  if (before.success === true) {
    assert("data" in before, "data-bearing command carries data");
    assert(isPlanRuntimeSnapshot(before.data), "snapshot passes the shared guard");
    assertEqual(before.data!.phase, "cancelled", "initial phase cancelled");
    assertEqual(before.data!.planId, null, "initial planId null");
    assertEqual(before.data!.schemaVersion, PLAN_SCHEMA_VERSION, "schemaVersion 1");
  }

  await ipc.invoke("plan-command", { type: "enter_planning", requestText: "snapshot me" });
  const during = (await ipc.invoke("plan-command", { type: "get_snapshot" })) as PixCommandResult<PlanRuntimeSnapshot | undefined>;
  if (during.success === true) {
    assertEqual(during.data!.phase, "planning", "snapshot reflects planning");

    // The returned snapshot is a defensive clone.
    during.data!.updatedAt = 0;
    assertEqual(c.getSnapshot().updatedAt > 0, true, "mutating the returned snapshot does not affect the controller");
  } else {
    failed++;
    console.error("  FAIL: get_snapshot after enter_planning returned a failure envelope");
  }
});

await run("plan-event forwarding: plan_state / plan_step / plan_deviation", async () => {
  const h = makeHarness();
  const c = makeController(h);
  const webContents = new FakeWebContents();
  const unsubscribe = subscribePlanEventForwarding(() => webContents, () => c);

  const ipc = new FakeIpcMain();
  registerPlanIpcHandlers(ipc, () => c);
  await ipc.invoke("plan-command", { type: "enter_planning", requestText: "eventful plan" });
  const submitted = await c.submitPlan({ ...makeBranchDraft(), generationId: c.getSnapshot().generation!.generationId });
  assert(submitted.accepted, "draft accepted");
  const snapshot = c.getSnapshot();
  const planId = snapshot.planId!;
  const version = snapshot.plan!.version;
  const s0 = snapshot.plan!.steps[0];

  const stateEvents = webContents.eventsOn("plan-event").filter((e) => (e as PlanEvent).type === "plan_state") as Array<{ type: "plan_state"; snapshot: { phase: string } }>;
  assert(stateEvents.length > 0, "plan_state events forwarded");
  // Subscribing to a non-null controller re-syncs and pushes its current
  // snapshot first (initial phase cancelled); the live planning event follows.
  assertEqual(stateEvents[0].snapshot.phase, "cancelled", "re-sync pushes the current snapshot on subscribe");
  assert(stateEvents.some((e) => e.snapshot.phase === "planning"), "planning plan_state forwarded after enter_planning");

  // plan_step: a step transition emits a step-level event.
  await c.approve(planId, version);
  await c.startExecution(planId, version);
  const stepRun = await c.updatePlanStep({ planId, version, stepId: s0.stepId, status: "running" });
  assert(stepRun.accepted, "step running accepted");
  const stepEvents = webContents.eventsOn("plan-event").filter((e) => (e as PlanEvent).type === "plan_step") as Array<{ type: "plan_step"; planId: string; version: number; step: PlanStep }>;
  const runEvent = stepEvents.find((e) => e.step.stepId === s0.stepId);
  assert(runEvent !== undefined, "plan_step forwarded for the running step");
  assertEqual(runEvent!.step.status, "running", "step event carries the new status");
  assertEqual(runEvent!.planId, planId, "step event planId");
  assertEqual(runEvent!.version, version, "step event version");

  // plan_deviation: emit an undeclared file change while the step is running.
  h.session.emit({
    type: "file_change",
    toolCallId: "fc-1",
    toolName: "edit",
    change: { path: "src/undeclared.txt", toolCallId: "fc-1", toolName: "edit", added: 1, removed: 0 },
    aggregate: { added: 1, removed: 0, files: 1, changes: [] },
  });
  await waitFor(
    () => webContents.eventsOn("plan-event").some((e) => (e as PlanEvent).type === "plan_deviation"),
    20000,
    "plan_deviation forwarded",
  );
  const deviationEvents = webContents.eventsOn("plan-event").filter((e) => (e as PlanEvent).type === "plan_deviation") as Array<{ type: "plan_deviation"; deviation: PlanDeviation }>;
  assertEqual(deviationEvents[0].deviation.type, "file_out_of_scope", "deviation type forwarded");
  assertEqual(deviationEvents[0].deviation.path, "src/undeclared.txt", "deviation path forwarded");

  // Unsubscribe stops forwarding.
  const beforeCount = webContents.eventsOn("plan-event").length;
  unsubscribe();
  await ipc.invoke("plan-command", { type: "cancel", planId, version });
  assertEqual(webContents.eventsOn("plan-event").length, beforeCount, "unsubscribe stops forwarding");
});

await run("event forwarding survives a controller instance swap", async () => {
  const h = makeHarness();
  const first = makeController(h);
  const webContents = new FakeWebContents();
  let current: PlanController | null = first;
  const unsubscribe = subscribePlanEventForwarding(() => webContents, () => current);

  await first.enterPlanning({ text: "first controller" });
  assert(webContents.eventsOn("plan-event").length > 0, "first controller events forwarded");

  // A session switch replaces the controller instance; the next plan command
  // re-syncs the forwarding subscription so the replacement controller's
  // events are captured.
  const second = makeController(h);
  current = second;
  const ipc = new FakeIpcMain();
  registerPlanIpcHandlers(ipc, () => current);
  const entered = (await ipc.invoke("plan-command", { type: "enter_planning", requestText: "second controller" })) as PixCommandResult;
  assertEqual(entered.success, true, "enter_planning on the replacement controller succeeds");
  const stateEvents = webContents.eventsOn("plan-event").filter((e) => (e as PlanEvent).type === "plan_state");
  assert(stateEvents.length >= 2, "events from the replacement controller forwarded");
  unsubscribe();
});

await run("sync re-subscription pushes the replacement controller snapshot", async () => {
  // A session switch replaces the PlanController instance. The re-sync hook
  // (invoked by the session-switching command paths) must detect the swap and
  // push the replacement's current snapshot, so the renderer mirror converges
  // to the new session's plan without waiting for the next plan command.
  const h = makeHarness();
  const first = makeController(h);
  const second = makeController(h);
  const webContents = new FakeWebContents();
  let current: PlanController | null = first;
  const unsubscribe = subscribePlanEventForwarding(() => webContents, () => current);

  // Give the first controller a distinguishable state (awaiting_approval).
  await driveToAwaitingApproval(first);
  assertEqual(first.getSnapshot().phase, "awaiting_approval", "first controller holds a plan");
  const beforeSwap = webContents.eventsOn("plan-event").filter((e) => (e as PlanEvent).type === "plan_state").length;

  // Emulate a session switch: the bridge replaces the controller instance and
  // the command path re-syncs the event forwarding.
  current = second;
  resyncPlanEventForwarding();

  const stateEvents = webContents.eventsOn("plan-event").filter((e) => (e as PlanEvent).type === "plan_state") as Array<{ type: "plan_state"; snapshot: PlanRuntimeSnapshot }>;
  assertEqual(stateEvents.length, beforeSwap + 1, "re-sync pushes exactly one snapshot on the controller swap");
  const lastState = stateEvents[stateEvents.length - 1];
  assert(lastState !== undefined, "plan_state pushed on controller change");
  assertEqual(lastState.snapshot.phase, "cancelled", "pushed snapshot comes from the replacement controller (no plan)");
  assertEqual(lastState.snapshot.planId, null, "replacement snapshot has no plan");

  // A re-sync while the controller is stable must not push again.
  const beforeStable = stateEvents.length;
  resyncPlanEventForwarding();
  assertEqual(
    webContents.eventsOn("plan-event").filter((e) => (e as PlanEvent).type === "plan_state").length,
    beforeStable,
    "stable controller re-sync pushes no duplicate snapshot",
  );

  // The replacement controller's live events are forwarded after the swap.
  await second.enterPlanning({ text: "second controller" });
  assert(
    webContents.eventsOn("plan-event").filter((e) => (e as PlanEvent).type === "plan_state").some(
      (e) => (e as { snapshot: { phase: string } }).snapshot.phase === "planning",
    ),
    "replacement controller live events forwarded after swap",
  );
  unsubscribe();
});

// ============================================================================

rmSync(WORKSPACE, { recursive: true, force: true });

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
