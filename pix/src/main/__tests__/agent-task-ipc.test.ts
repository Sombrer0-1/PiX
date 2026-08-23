/**
 * AgentTask IPC tests (PiX 1.4.1 B5; 1.5 P1 surface).
 *
 * Covers the §4.9 AgentTaskCommand/AgentTaskEvent contract end-to-end with an
 * INJECTABLE IPC adapter (pure Node, no Electron runtime): the 1.5 command
 * surface (cancel / respond_input / cancel_input / get_all /
 * get_active_input_requests / export_diagnostics), rejection of the removed
 * 1.4 manual-operation commands, the existing {success,data?,error,code?}
 * PixApi envelope (data-bearing commands carry data, data-less commands omit
 * it), per-command data narrowing, the dedicated agent-task-input-request
 * channel (input requests never travel on the ordinary event stream), the
 * main-only task_file_change event never crossing IPC, the remount catch-up
 * (get-pending-agent-task-input-requests), throttled activities/output
 * reaching the renderer, state visibility within 1s, and the 1.5 delivery
 * catch-up (an undelivered terminal background result lands the moment its
 * parent session opens a sink).
 *
 * IPC harness rule (design plan §3): the test registers the REAL production
 * handlers from ipc-agent-task-adapters.ts on a top-level-imported injectable
 * IpcMainLike/WebContentsLike adapter; production registerIpcHandlers passes
 * the real ipcMain / win.webContents. ipc-handlers.ts itself cannot be
 * imported from pure Node (its electron import chain, including
 * file-dialogs.ts, fails to load outside the Electron runtime), so the
 * plan/agent-task registration and dispatch were extracted into pure modules
 * (ipc-plan-adapters.ts / ipc-agent-task-adapters.ts) that the IPC tests
 * import directly - no mirror, no lockstep. The command semantics are
 * exercised against the REAL AgentTaskService (with the real nested-session
 * runtime replaced by a controllable fake via __setAgentTaskServiceHooksForTests,
 * same as agent-task-service.test.ts).
 *
 * Run with: npm exec tsx -- src/main/__tests__/agent-task-ipc.test.ts
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentDefinition, FileChangeSummary, LoadAgentsResult, TurnDiffSummary } from "@earendil-works/pi-coding-agent";
import { isProductEvent, type ProductEvent } from "../../shared/product-events.js";
import {
  isAgentTaskInfo,
  type AgentTaskActivity,
  type AgentTaskInfo,
  type AgentTaskLogSnapshot,
  type AgentTaskSpec,
  type AgentTaskUsage,
} from "../../shared/agent-task-types.js";
import type {
  AgentTaskCommand,
  AgentTaskEvent,
  AgentTaskInputRequest,
  PixCommandResult,
  RequestUserInputRequest,
  RequestUserInputResponse,
} from "../../shared/types.js";
import type { SubagentDetails, SubagentSingleResult } from "../../shared/subagent-types.js";
import type { ProjectLocation } from "../../shared/project-location.js";
import {
  isAgentTaskCommand,
  registerAgentTaskIpcHandlers,
  subscribeAgentTaskEventForwarding,
  type IpcMainLike,
  type WebContentsLike,
} from "../ipc-agent-task-adapters.js";
import { workspaceIdOf } from "../agent-task/agent-task-identity.js";
import { SettingsStore } from "../settings-store.js";
import type { ProductEventCollector } from "../product-event-collector.js";
import type { SubagentParentRuntimeSnapshot, SubagentTaskItem } from "../subagent/types.js";
import type { AgentTaskInputRouter } from "../agent-task/agent-task-input.js";
import type { AgentTaskRuntime, AgentTaskRuntimeResult } from "../agent-task/agent-task-runtime.js";
import { AgentTaskStore } from "../agent-task/agent-task-store.js";
import {
  AgentTaskService,
  __setAgentTaskServiceHooksForTests,
  type AgentTaskServiceEvent,
  type AgentTaskServiceTestHooks,
  type AgentTaskSubmissionContext,
  type CreateTaskParams,
} from "../agent-task/agent-task-service.js";

// ============================================================================
// Test harness (matches agent-task-service.test.ts style)
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
function assertFailure(result: PixCommandResult, message: string): { success: false; error: string; code?: string } {
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

function emptyUsage(): AgentTaskUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, turns: 0 };
}

// ============================================================================
// Fakes
// ============================================================================

const PROJECT: ProjectLocation = {
  path: "E:\\proj\\demo",
  physicalPath: "E:\\proj\\demo",
  name: "demo",
  environment: { kind: "windows" },
};

function makeModel(id: string, provider = "faux"): Model<Api> {
  return {
    id,
    name: id,
    api: "faux-api",
    provider,
    baseUrl: "http://localhost:1",
    reasoning: false,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100000,
    maxTokens: 4096,
  } as Model<Api>;
}

function makeAgent(name: string, source: AgentDefinition["source"] = "user"): AgentDefinition {
  return {
    name,
    description: `${name} description`,
    systemPrompt: `${name} system prompt`,
    source,
    filePath: source === "built-in" ? undefined : `agents/${name}.md`,
    baseDir: "agents",
  };
}

function makeTask(index: number, agentName = "general-purpose"): SubagentTaskItem {
  return {
    subagent_type: agentName,
    prompt: `Task prompt ${index} - do the thing`,
    description: `Task ${index} description`,
  };
}

const PARENT_RUNTIME: SubagentParentRuntimeSnapshot = {
  model: makeModel("parent-model", "faux"),
  thinkingLevel: "xhigh",
  executionMode: "approval",
  verificationGate: false,
};

/** Captures product events like the real collector (guard + no-op flush). */
class FakeCollector {
  readonly records: ProductEvent[] = [];
  record(event: ProductEvent): void {
    if (isProductEvent(event)) {
      this.records.push(event);
    }
  }
}

interface FakeTimerEntry {
  callback: () => void;
  ms: number;
  cancelled: boolean;
}

/** Hand-rolled fake timers + fixed clock for the injectable service hooks. */
function makeFakeTimers(baseNow: number): {
  now: () => number;
  setTimer: (callback: () => void, ms: number) => { cancel: () => void };
  timers: () => FakeTimerEntry[];
  fireAll: () => void;
  fireMs: (ms: number) => void;
} {
  const entries: FakeTimerEntry[] = [];
  return {
    now: () => baseNow,
    setTimer: (callback, ms) => {
      const entry: FakeTimerEntry = { callback, ms, cancelled: false };
      entries.push(entry);
      return {
        cancel: () => {
          entry.cancelled = true;
        },
      };
    },
    timers: () => entries,
    fireAll: () => {
      for (const entry of [...entries]) {
        if (!entry.cancelled) {
          entry.callback();
        }
      }
    },
    fireMs: (ms) => {
      for (const entry of [...entries]) {
        if (!entry.cancelled && entry.ms === ms) {
          entry.callback();
        }
      }
    },
  };
}

type AgentTaskRuntimeEventLike =
  | { type: "activity"; activity: AgentTaskActivity }
  | { type: "output"; text: string; truncated: boolean; originalBytes: number }
  | { type: "file_change"; change: FileChangeSummary; aggregate: TurnDiffSummary }
  | { type: "assistant_finalized"; entryId: string }
  | { type: "item_result"; result: SubagentSingleResult }
  | { type: "nested_transcript"; itemIndex: number; event: object }
  | { type: "item_session"; itemIndex: number; sessionFileName: string };

class FakeRuntime {
  static instances: FakeRuntime[] = [];

  readonly spec: AgentTaskSpec;
  input: AgentTaskInputRouter | undefined;
  signal: AbortSignal | undefined;
  onEvent: ((event: AgentTaskRuntimeEventLike) => void) | undefined;
  abortCalls = 0;
  disposeCalls = 0;
  readonly resolveInputCalls: Array<{ requestId: string; response: RequestUserInputResponse }> = [];
  readonly cancelInputCalls: string[] = [];
  private _resolveRun: ((result: AgentTaskRuntimeResult) => void) | undefined;
  settled = false;
  // 1.4.2 (R3): recorded resume seeds.
  readonly resumeSeeds: unknown[] = [];
  prepareCalls = 0;

  constructor(spec: AgentTaskSpec) {
    this.spec = spec;
    FakeRuntime.instances.push(this);
  }

  /** 1.4.2 (R3): mirrors the real runtime's prepareResume contract minimally. */
  prepareResume(seed: unknown): Promise<{ generation: number; seq: number; activeItemIndex: number; sessionFileName: string | null; sessionLeafId: string | null; lastFinalizedEntryId?: string; openToolCalls: unknown[]; workspaceFingerprint: unknown; ts: number }> {
    this.resumeSeeds.push(seed);
    this.prepareCalls++;
    const checkpoint = (seed as { checkpoint: { generation: number; seq: number; activeItemIndex: number; sessionFileName: string | null; sessionLeafId: string | null; lastFinalizedEntryId?: string; workspaceFingerprint: unknown } }).checkpoint;
    return Promise.resolve({
      taskId: this.spec.taskId,
      generation: checkpoint.generation,
      seq: checkpoint.seq,
      activeItemIndex: checkpoint.activeItemIndex,
      sessionFileName: checkpoint.sessionFileName,
      sessionLeafId: checkpoint.sessionLeafId,
      lastFinalizedEntryId: checkpoint.lastFinalizedEntryId,
      openToolCalls: [],
      workspaceFingerprint: checkpoint.workspaceFingerprint,
      ts: Date.now(),
    });
  }

  emitAssistantFinalized(): void {
    this.onEvent?.({ type: "assistant_finalized", entryId: `final-${this.spec.taskId}` });
  }

  run(signal: AbortSignal, onEvent: (event: AgentTaskRuntimeEventLike) => void): Promise<AgentTaskRuntimeResult> {
    this.signal = signal;
    this.onEvent = onEvent;
    return new Promise<AgentTaskRuntimeResult>((resolve) => {
      this._resolveRun = resolve;
    });
  }

  /** Simulates the nested session requesting user input (via the router). */
  requestInput(controller: AbortController, request: RequestUserInputRequest): void {
    this.input?.enqueue(this.spec.taskId, 0, request, controller.signal);
  }

  emitActivity(activity: AgentTaskActivity): void {
    this.onEvent?.({ type: "activity", activity });
  }

  emitOutput(text: string, truncated = false, originalBytes = text.length): void {
    this.onEvent?.({ type: "output", text, truncated, originalBytes });
  }

  emitFileChange(): void {
    this.onEvent?.({
      type: "file_change",
      change: { path: "src/a.txt", toolCallId: "fc-1", toolName: "edit", added: 1, removed: 0 },
      aggregate: { added: 1, removed: 0, files: 1, changes: [] },
    });
  }

  complete(partial?: Partial<AgentTaskRuntimeResult>): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this._resolveRun?.({
      status: "completed",
      finalOutput: `final-${this.spec.taskId}`,
      results: this.spec.items.map((item, index) => this.makeItemResult(item, index)),
      usage: emptyUsage(),
      activities: [],
      ...partial,
    });
  }

  private makeItemResult(item: AgentTaskSpec["items"][number], index: number): SubagentSingleResult {
    return {
      id: `fake-${this.spec.taskId}-${index}`,
      index: item.index,
      step: this.spec.mode === "chain" ? item.index + 1 : undefined,
      agentName: item.resolution === "ready" ? item.agent.name : item.requestedAgentName ?? "general-purpose",
      agentSource: item.resolution === "ready" ? item.agent.source : "unknown",
      description: item.description,
      status: "completed",
      finalOutput: `output-${index}`,
      outputTruncated: false,
      originalOutputBytes: 0,
      toolUseCount: 1,
      activities: [],
      usage: emptyUsage(),
      model: item.resolution === "ready" ? `${item.model.provider}/${item.model.modelId}` : undefined,
      startedAt: 1000,
      endedAt: 2000,
      durationMs: 1000,
    };
  }

  abort(): void {
    this.abortCalls++;
    // A real runtime settles as cancelled shortly after abort; mirror that so
    // cancel tests reach the terminal state without extra wiring.
    if (!this.settled) {
      this.complete({
        status: "cancelled",
        results: this.spec.items.map((item, index) => ({
          ...this.makeItemResult(item, index),
          status: "aborted",
          failureReason: "aborted",
          errorMessage: "The agent task was aborted.",
        })),
      });
    }
  }

  dispose(): Promise<void> {
    this.disposeCalls++;
    return Promise.resolve();
  }

  // 1.5 (P3): transcript forwarding switch mirror.
  forwarding = false;
  readonly forwardingCalls: boolean[] = [];

  setTranscriptForwarding(enabled: boolean): void {
    this.forwarding = enabled;
    this.forwardingCalls.push(enabled);
  }

  emitNestedTranscript(itemIndex: number, event: object): void {
    this.onEvent?.({ type: "nested_transcript", itemIndex, event });
  }

  emitItemSession(itemIndex: number, sessionFileName: string): void {
    this.onEvent?.({ type: "item_session", itemIndex, sessionFileName });
  }

  resolveInput(requestId: string, response: RequestUserInputResponse): boolean {
    this.resolveInputCalls.push({ requestId, response });
    return true;
  }

  cancelInput(requestId: string): boolean {
    this.cancelInputCalls.push(requestId);
    return true;
  }
}

interface Harness {
  service: AgentTaskService;
  events: ProductEventCollector;
  settings: SettingsStore;
  store: AgentTaskStore;
  storeRoot: string;
  resolveHostDisposed: () => void;
  hostDisposed: Promise<"host_disposed">;
}

/**
 * Fresh service per harness: real SettingsStore (temp cwd) + fake collector,
 * fake runtimes, auto-background disabled by default unless overridden.
 */
function makeHarness(extraHooks?: Partial<AgentTaskServiceTestHooks>, opts?: { storeRoot?: string }): Harness {
  FakeRuntime.instances = [];
  const cwd = mkdtempSync(join(tmpdir(), "pix-agent-task-ipc-"));
  const settings = new SettingsStore({ cwd });
  settings.set("enableProductAnalytics", true);
  const events = new FakeCollector() as unknown as ProductEventCollector;
  let resolveHostDisposed: () => void = () => {};
  const hostDisposed = new Promise<"host_disposed">((resolve) => {
    resolveHostDisposed = () => resolve("host_disposed");
  });
  // 1.4.2 (R2): the service requires a real store + frozen runId.
  const storeRoot = opts?.storeRoot ?? mkdtempSync(join(tmpdir(), "pix-agent-task-ipc-store-"));
  const store = new AgentTaskStore({
    rootDir: storeRoot,
    maxTaskBytes: 25 * 1024 * 1024,
    maxWorkspaceBytes: 500 * 1024 * 1024,
  });
  const service = new AgentTaskService({ settings, events, store, runId: "test-run-ipc" });
  __setAgentTaskServiceHooksForTests({
    autoBackgroundMsOverride: 0,
    runtimeFactory: (spec, input) => {
      const fake = new FakeRuntime(spec);
      fake.input = input;
      return fake as unknown as AgentTaskRuntime;
    },
    ...extraHooks,
  });
  return { service, events, settings, store, storeRoot, resolveHostDisposed, hostDisposed };
}

function makeContext(harness: Harness, overrides?: Partial<AgentTaskSubmissionContext>): AgentTaskSubmissionContext {
  // The fake catalog replaces the built-ins, so it must carry its own
  // general-purpose entry for the default task name to resolve.
  const loaded: LoadAgentsResult = {
    agents: [makeAgent("general-purpose", "built-in"), makeAgent("user-helper", "user")],
    projectAgentsDir: "E:\\proj\\demo\\.pi\\agents",
    diagnostics: [],
  };
  return {
    parentSessionId: "session-1",
    parentToolCallId: "tool-call-1",
    project: { ...PROJECT },
    agentDir: join(tmpdir(), "pix-agent-task-ipc-agent"),
    loadedAgents: loaded,
    modelRegistry: {
      getAll: () => [makeModel("alpha", "faux")],
      find: (provider: string, modelId: string) =>
        provider === "faux" && modelId === "alpha" ? makeModel(modelId, "faux") : undefined,
      hasConfiguredAuth: () => true,
    } as never,
    parentRuntime: { ...PARENT_RUNTIME },
    requestUserInput: async () => ({ id: "unused", answers: {}, cancelled: true }),
    hostDisposed: harness.hostDisposed,
    ...overrides,
  };
}

function makeParams(
  mode: "single" | "parallel" | "chain",
  tasks: SubagentTaskItem[],
  overrides?: Partial<CreateTaskParams>,
): CreateTaskParams {
  return {
    mode,
    agentScope: "user",
    tasks,
    runInBackground: false,
    ...overrides,
  };
}

async function createSingleForegroundTask(harness: Harness, overrides?: Partial<CreateTaskParams>): Promise<{ taskId: string; runtime: FakeRuntime }> {
  const handle = await harness.service.createTaskGroup(makeParams("single", [makeTask(0)], overrides), makeContext(harness), "foreground");
  const runtime = FakeRuntime.instances.find((fake) => fake.spec.taskId === handle.tasks[0].taskId);
  if (!runtime) {
    throw new Error("FakeRuntime for the single task not found");
  }
  return { taskId: handle.tasks[0].taskId, runtime };
}

function findTask(harness: Harness, taskId: string): AgentTaskInfo {
  const task = harness.service.getAll().tasks.find((info) => info.taskId === taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }
  return task;
}

function makeInputRequest(id: string): RequestUserInputRequest {
  return { id, questions: [{ id: "q1", header: "问题", question: "继续吗？" }] };
}

// ============================================================================
// Injectable IPC adapter (pure Node; REAL handlers imported from
// ipc-agent-task-adapters.ts - no mirror, no lockstep)
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

function taskStateEvents(webContents: FakeWebContents): Array<{ type: "task_state"; task: AgentTaskInfo }> {
  return webContents.eventsOn("agent-task-event").filter((e) => (e as AgentTaskEvent).type === "task_state") as Array<{
    type: "task_state";
    task: AgentTaskInfo;
  }>;
}

// ============================================================================
// Tests
// ============================================================================

await run("registration: invalid commands rejected with invalid_agent_task_command", async () => {
  const harness = makeHarness();
  const ipc = new FakeIpcMain();
  registerAgentTaskIpcHandlers(ipc, harness.service);

  const bogus = (await ipc.invoke("agent-task-command", { type: "bogus" })) as PixCommandResult;
  const bogusFailure = assertFailure(bogus, "unknown type rejected");
  assertEqual(bogusFailure.code, "invalid_agent_task_command", "invalid_agent_task_command code");
  assert(bogusFailure.error.includes("Invalid agent task command"), "error message present");

  const noTaskId = (await ipc.invoke("agent-task-command", { type: "cancel" })) as PixCommandResult;
  assertFailure(noTaskId, "cancel without taskId rejected");

  const badGeneration = (await ipc.invoke("agent-task-command", { type: "cancel", taskId: "t", generation: "1" })) as PixCommandResult;
  assertFailure(badGeneration, "non-numeric generation rejected");

  const negativeGeneration = (await ipc.invoke("agent-task-command", { type: "cancel", taskId: "t", generation: -1 })) as PixCommandResult;
  assertFailure(negativeGeneration, "negative generation rejected");

  const noResponse = (await ipc.invoke("agent-task-command", {
    type: "respond_input",
    taskId: "t",
    requestId: "r",
    generation: 0,
  })) as PixCommandResult;
  assertFailure(noResponse, "respond_input without response rejected");
});

await run("registration: removed 1.4 manual-operation commands are rejected", async () => {
  const harness = makeHarness();
  const ipc = new FakeIpcMain();
  registerAgentTaskIpcHandlers(ipc, harness.service);

  // 1.5 (P1): send_to_session / clear / clear_all_terminal / background /
  // foreground / continue_foreground_wait / resume / mark_failed /
  // get_resume_summary are gone from the contract - delivery catch-up,
  // auto-recovery and retention are main-process automations now.
  const removed: Array<Record<string, unknown>> = [
    { type: "background", taskId: "t", generation: 0 },
    { type: "foreground", taskId: "t", generation: 0 },
    { type: "continue_foreground_wait", taskId: "t", generation: 0 },
    { type: "send_to_session", taskId: "t", generation: 0, targetSessionId: "s" },
    { type: "clear", taskId: "t", generation: 0, confirmDataLoss: true },
    { type: "clear_all_terminal", confirm: true },
    { type: "resume", taskId: "t", generation: 0, decision: { action: "continue", confirmWorkspaceChanges: false } },
    { type: "mark_failed", taskId: "t", generation: 0 },
    { type: "get_resume_summary", taskId: "t", generation: 0 },
  ];
  for (const command of removed) {
    const result = (await ipc.invoke("agent-task-command", command)) as PixCommandResult;
    const failure = assertFailure(result, `${command.type} rejected`);
    assertEqual(failure.code, "invalid_agent_task_command", `${command.type} invalid_agent_task_command code`);
  }
});

await run("S1/S4: V15 commands pass the guard; watch/unwatch/get_transcript dispatch for real", async () => {
  const harness = makeHarness();
  const ipc = new FakeIpcMain();
  registerAgentTaskIpcHandlers(ipc, harness.service);

  // Structural guard: every legal V15 command shape passes isAgentTaskCommand
  // (get_transcript accepts itemIndex/cursor/limit either absent or valid).
  const valid: Array<Record<string, unknown>> = [
    { type: "watch_task", taskId: "t-1" },
    { type: "unwatch_task", taskId: "t-1" },
    { type: "get_transcript", taskId: "t-1" },
    { type: "get_transcript", taskId: "t-1", itemIndex: 0 },
    { type: "get_transcript", taskId: "t-1", itemIndex: 3, cursor: "o=42", limit: 200 },
    { type: "get_transcript", taskId: "t-1", limit: 1000 },
    { type: "get_task_log", taskId: "t-1" },
  ];
  for (const command of valid) {
    assert(isAgentTaskCommand(command), `structural guard accepts ${command.type}`);
  }

  // Negative guard paths: missing taskId, non-integer/negative itemIndex,
  // non-positive/non-integer limit, non-string cursor.
  const invalid: Array<Record<string, unknown>> = [
    { type: "watch_task" },
    { type: "unwatch_task", taskId: 7 },
    { type: "get_task_log" },
    { type: "get_transcript", taskId: "t-1", itemIndex: -1 },
    { type: "get_transcript", taskId: "t-1", itemIndex: 1.5 },
    { type: "get_transcript", taskId: "t-1", limit: 0 },
    { type: "get_transcript", taskId: "t-1", limit: -5 },
    { type: "get_transcript", taskId: "t-1", limit: 200.5 },
    { type: "get_transcript", taskId: "t-1", cursor: 42 },
  ];
  for (const command of invalid) {
    assert(!isAgentTaskCommand(command), `structural guard rejects ${JSON.stringify(command)}`);
  }

  // watch_task on an unknown task is the precise not_found mapping.
  const watchUnknown = (await ipc.invoke("agent-task-command", { type: "watch_task", taskId: "t-1" })) as PixCommandResult;
  const watchFailure = assertFailure(watchUnknown, "watch_task fails for an unknown task");
  assertEqual(watchFailure.code, "not_found", "watch_task not_found code");
  assertEqual(watchFailure.error, "Agent task not found: t-1", "watch_task not_found error text");

  // unwatch_task is idempotent: an unknown task still succeeds.
  const unwatchUnknown = (await ipc.invoke("agent-task-command", { type: "unwatch_task", taskId: "t-1" })) as PixCommandResult;
  assertEqual(unwatchUnknown.success, true, "unwatch_task succeeds for an unknown task");

  // get_transcript / get_task_log on an unknown task are the same not_found
  // mapping (the latter lands with S6's real dispatch).
  const transcriptUnknown = (await ipc.invoke("agent-task-command", { type: "get_transcript", taskId: "t-1" })) as PixCommandResult;
  const transcriptFailure = assertFailure(transcriptUnknown, "get_transcript fails for an unknown task");
  assertEqual(transcriptFailure.code, "not_found", "get_transcript not_found code");
  assertEqual(transcriptFailure.error, "Agent task not found: t-1", "get_transcript not_found error text");
  const getTaskLog = (await ipc.invoke("agent-task-command", { type: "get_task_log", taskId: "t-1" })) as PixCommandResult;
  const getTaskLogFailure = assertFailure(getTaskLog, "get_task_log fails for an unknown task");
  assertEqual(getTaskLogFailure.code, "not_found", "get_task_log not_found code");
  assertEqual(getTaskLogFailure.error, "Agent task not found: t-1", "get_task_log not_found error text");
});

await run("get_all / get_active_input_requests: data envelopes + per-command narrowing", async () => {
  const harness = makeHarness();
  const ipc = new FakeIpcMain();
  registerAgentTaskIpcHandlers(ipc, harness.service);
  await harness.service.createTaskGroup(makeParams("parallel", [makeTask(0), makeTask(1)]), makeContext(harness), "foreground");

  // get_all is data-bearing: since 1.4.2 (R2) it must carry the full
  // AgentTaskListSnapshot (tasks + recoveryIssues + storageStatuses).
  const all = (await ipc.invoke("agent-task-command", { type: "get_all" })) as PixCommandResult<{
    tasks: AgentTaskInfo[];
    recoveryIssues: unknown[];
    storageStatuses: unknown[];
  }>;
  assertEqual(all.success, true, "get_all succeeds");
  if (all.success === true) {
    assert("data" in all, "data-bearing command carries data");
    const snapshot = all.data!;
    assertEqual(typeof snapshot, "object", "get_all data is an object snapshot");
    assert(Array.isArray(snapshot.tasks), "snapshot carries a tasks array");
    assertEqual(snapshot.tasks.length, 2, "get_all lists both tasks");
    assert(snapshot.tasks.every((info) => isAgentTaskInfo(info)), "every get_all task passes isAgentTaskInfo");
    assertEqual(snapshot.tasks[0].generation, 0, "fresh tasks carry generation 0");
    assert(Array.isArray(snapshot.recoveryIssues), "snapshot carries recoveryIssues");
    assertEqual(snapshot.recoveryIssues.length, 0, "no recovery issues for healthy tasks");
    assert(Array.isArray(snapshot.storageStatuses), "snapshot carries storageStatuses");
    assert(snapshot.storageStatuses.length >= 1, "at least one workspace storage status present");
  }

  // get_active_input_requests is data-bearing; empty list when nothing waits.
  const inputs = (await ipc.invoke("agent-task-command", { type: "get_active_input_requests" })) as PixCommandResult<AgentTaskInputRequest[]>;
  assertEqual(inputs.success, true, "get_active_input_requests succeeds");
  if (inputs.success === true) {
    assert("data" in inputs, "data-bearing command carries data");
    assert(Array.isArray(inputs.data), "active input requests data is an array");
    assertEqual(inputs.data!.length, 0, "no pending input requests initially");
  }

  // Data-less command: success envelope omits data entirely.
  const stale = (await ipc.invoke("agent-task-command", {
    type: "cancel",
    taskId: "no-such-task",
    generation: 999,
  })) as PixCommandResult;
  const staleFailure = assertFailure(stale, "cancel on an unknown task fails");
  assertEqual(staleFailure.code, "not_found", "not_found code");
});

await run("cancel: success envelope, forwarded task_state, stale generation", async () => {
  const harness = makeHarness();
  const ipc = new FakeIpcMain();
  registerAgentTaskIpcHandlers(ipc, harness.service);
  const webContents = new FakeWebContents();
  const unsubscribe = subscribeAgentTaskEventForwarding(() => webContents, harness.service);
  const { taskId } = await createSingleForegroundTask(harness);

  const result = (await ipc.invoke("agent-task-command", { type: "cancel", taskId, generation: 0 })) as PixCommandResult;
  assertEqual(result.success, true, "cancel succeeds");
  if (result.success === true) {
    assert(!("data" in result), "data-less command omits data on success");
  }

  await waitFor(
    () => taskStateEvents(webContents).some((e) => e.task.taskId === taskId && e.task.status === "cancelled"),
    20000,
    "cancelled task_state forwarded",
  );
  const forwarded = taskStateEvents(webContents).find((e) => e.task.taskId === taskId && e.task.status === "cancelled")!;
  assert(isAgentTaskInfo(forwarded.task), "forwarded task_state payload passes isAgentTaskInfo");
  assertEqual(forwarded.task.generation, 0, "forwarded info carries the generation");

  // A second cancel with the current generation is terminal; a stale
  // generation is rejected before any state check.
  const again = (await ipc.invoke("agent-task-command", { type: "cancel", taskId, generation: 0 })) as PixCommandResult;
  const againFailure = assertFailure(again, "cancel on a terminal task fails");
  assertEqual(againFailure.code, "already_terminal", "already_terminal code");

  const stale = (await ipc.invoke("agent-task-command", { type: "cancel", taskId, generation: 999 })) as PixCommandResult;
  const staleFailure = assertFailure(stale, "cancel with a stale generation fails");
  assertEqual(staleFailure.code, "stale_generation", "stale_generation code");

  unsubscribe();
});

await run("delivery catch-up: an undelivered terminal background result lands when the parent sink opens", async () => {
  const harness = makeHarness();
  const ipc = new FakeIpcMain();
  registerAgentTaskIpcHandlers(ipc, harness.service);
  // Direct background (lane B): the group starts detached, so its terminal
  // result is eligible for auto-delivery / catch-up.
  const handle = await harness.service.createTaskGroup(
    makeParams("single", [makeTask(0)], { runInBackground: true }),
    makeContext(harness),
    "foreground",
  );
  const taskId = handle.tasks[0].taskId;
  const runtime = FakeRuntime.instances.find((fake) => fake.spec.taskId === taskId);
  if (!runtime) {
    throw new Error("FakeRuntime for the background task not found");
  }
  const workspaceId = findTask(harness, taskId).workspaceId;
  const parentSessionId = findTask(harness, taskId).parentSessionId;

  // The task finishes while NO sink exists: the result stays undelivered.
  runtime.complete();
  await waitFor(() => findTask(harness, taskId).status === "completed", 20000, "task completed");
  assertEqual(findTask(harness, taskId).deliveredSessionIds.length, 0, "no delivery without an open sink");

  // A sink for another workspace opens: no catch-up (workspace guard).
  let wrongDelivered = 0;
  harness.service.registerSessionDeliverySink("other-session", "other-workspace", async () => {
    wrongDelivered++;
  });
  await drain();
  await drain();
  assertEqual(wrongDelivered, 0, "no catch-up to a different workspace session");
  assertEqual(findTask(harness, taskId).deliveredSessionIds.length, 0, "still undelivered");

  // The parent session opens its sink: the catch-up delivers exactly once.
  let delivered = 0;
  const deliveredContents: string[] = [];
  harness.service.registerSessionDeliverySink(parentSessionId, workspaceId, async (content) => {
    delivered++;
    deliveredContents.push(content.taskId);
  });
  await waitFor(() => findTask(harness, taskId).deliveredSessionIds.includes(parentSessionId), 20000, "catch-up delivered");
  assertEqual(delivered, 1, "the delivery sink ran once");
  assertEqual(deliveredContents[0], taskId, "the sink received this task's result");
  assertEqual(findTask(harness, taskId).deliveredSessionIds.length, 1, "delivery recorded once");

  // Re-registering the same session's sink never double-delivers.
  harness.service.registerSessionDeliverySink(parentSessionId, workspaceId, async () => {
    delivered++;
  });
  await drain();
  await drain();
  assertEqual(delivered, 1, "duplicate delivery suppressed by deliveredSessionIds");
});

await run("respond_input / cancel_input: triple validation + dedicated input channel", async () => {
  const harness = makeHarness();
  const ipc = new FakeIpcMain();
  registerAgentTaskIpcHandlers(ipc, harness.service);
  const webContents = new FakeWebContents();
  const unsubscribe = subscribeAgentTaskEventForwarding(() => webContents, harness.service);
  const { taskId, runtime } = await createSingleForegroundTask(harness);

  const controller = new AbortController();
  runtime.requestInput(controller, makeInputRequest("req-1"));
  await waitFor(
    () =>
      (webContents.eventsOn("agent-task-input-request") as AgentTaskInputRequest[]).some(
        (request) => request.taskId === taskId && request.requestId === "req-1",
      ),
    20000,
    "input request forwarded on the dedicated channel",
  );
  await waitFor(
    () => taskStateEvents(webContents).some((e) => e.task.taskId === taskId && e.task.status === "waiting_input"),
    20000,
    "waiting_input task_state forwarded",
  );

  // The input request never appears on the ordinary agent-task-event stream
  // ("task_input" is deliberately absent from the AgentTaskEvent union, so the
  // comparison goes through a broadened type on purpose).
  const inputOnEventStream = webContents
    .eventsOn("agent-task-event")
    .some((e) => (e as { type: string }).type === "task_input");
  assertEqual(inputOnEventStream, false, "input requests never travel on agent-task-event");

  // Matching triple: success + dismissal forwarded + runtime notified.
  const responded = (await ipc.invoke("agent-task-command", {
    type: "respond_input",
    taskId,
    requestId: "req-1",
    generation: 0,
    response: { id: "req-1", answers: { q1: "yes" } },
  })) as PixCommandResult;
  assertEqual(responded.success, true, "respond_input succeeds on the matching triple");
  if (responded.success === true) {
    assert(!("data" in responded), "data-less command omits data on success");
  }
  await waitFor(
    () =>
      webContents
        .eventsOn("agent-task-event")
        .some((e) => (e as AgentTaskEvent).type === "task_input_dismissed"),
    20000,
    "task_input_dismissed forwarded on agent-task-event",
  );
  const dismissed = webContents
    .eventsOn("agent-task-event")
    .find((e) => (e as AgentTaskEvent).type === "task_input_dismissed") as Extract<AgentTaskEvent, { type: "task_input_dismissed" }>;
  assertEqual(dismissed.taskId, taskId, "dismissal carries the taskId");
  assertEqual(dismissed.requestId, "req-1", "dismissal carries the requestId");
  assertEqual(dismissed.generation, 0, "dismissal carries the generation");
  assertEqual(runtime.resolveInputCalls.length, 1, "runtime received the resolved input");

  // The settled request can no longer be answered.
  const repeat = (await ipc.invoke("agent-task-command", {
    type: "respond_input",
    taskId,
    requestId: "req-1",
    generation: 0,
    response: { id: "req-1", answers: { q1: "yes" } },
  })) as PixCommandResult;
  const repeatFailure = assertFailure(repeat, "responding to a settled request fails");
  assertEqual(repeatFailure.code, "task_input_not_found", "task_input_not_found code");

  // Wrong requestId / stale generation on a live request.
  runtime.requestInput(controller, makeInputRequest("req-2"));
  await waitFor(() => harness.service.getActiveInputRequests().some((r) => r.requestId === "req-2"), 20000, "req-2 pending");
  const wrongId = (await ipc.invoke("agent-task-command", {
    type: "respond_input",
    taskId,
    requestId: "req-other",
    generation: 0,
    response: { id: "req-other", answers: {} },
  })) as PixCommandResult;
  const wrongIdFailure = assertFailure(wrongId, "respond_input with a mismatched requestId fails");
  assertEqual(wrongIdFailure.code, "task_input_not_found", "mismatched requestId code");

  const staleGen = (await ipc.invoke("agent-task-command", {
    type: "respond_input",
    taskId,
    requestId: "req-2",
    generation: 999,
    response: { id: "req-2", answers: {} },
  })) as PixCommandResult;
  const staleGenFailure = assertFailure(staleGen, "respond_input with a stale generation fails");
  assertEqual(staleGenFailure.code, "task_input_not_found", "stale generation on respond_input");

  // cancel_input with the matching triple cancels the pending request.
  const cancelledInput = (await ipc.invoke("agent-task-command", {
    type: "cancel_input",
    taskId,
    requestId: "req-2",
    generation: 0,
  })) as PixCommandResult;
  assertEqual(cancelledInput.success, true, "cancel_input succeeds on the matching triple");
  await waitFor(() => harness.service.getActiveInputRequests().length === 0, 20000, "pending input cleared");
  assertEqual(runtime.cancelInputCalls.length, 1, "runtime received the input cancellation");

  const cancelAgain = (await ipc.invoke("agent-task-command", {
    type: "cancel_input",
    taskId,
    requestId: "req-2",
    generation: 0,
  })) as PixCommandResult;
  const cancelAgainFailure = assertFailure(cancelAgain, "cancelling a settled request fails");
  assertEqual(cancelAgainFailure.code, "task_input_not_found", "settled cancel_input code");

  unsubscribe();
});

await run("remount compensation: pending input requests recoverable", async () => {
  const harness = makeHarness();
  const ipc = new FakeIpcMain();
  registerAgentTaskIpcHandlers(ipc, harness.service);
  const { taskId, runtime } = await createSingleForegroundTask(harness);
  const controller = new AbortController();
  runtime.requestInput(controller, makeInputRequest("req-remount"));
  await waitFor(() => harness.service.getActiveInputRequests().length === 1, 20000, "input request pending");

  // The preload getPendingAgentTaskInputRequests channel returns the active
  // requests without an envelope (same data as the get_active_input_requests
  // command).
  const pending = (await ipc.invoke("get-pending-agent-task-input-requests")) as AgentTaskInputRequest[];
  assertEqual(pending.length, 1, "remount catch-up returns the pending request");
  assertEqual(pending[0].taskId, taskId, "pending request taskId");
  assertEqual(pending[0].requestId, "req-remount", "pending request requestId");
  assertEqual(pending[0].generation, 0, "pending request generation");

  const viaCommand = (await ipc.invoke("agent-task-command", { type: "get_active_input_requests" })) as PixCommandResult<AgentTaskInputRequest[]>;
  if (viaCommand.success === true) {
    assertEqual(viaCommand.data!.length, 1, "get_active_input_requests matches the remount catch-up");
    assertEqual(JSON.stringify(viaCommand.data![0]), JSON.stringify(pending[0]), "identical request payloads");
  } else {
    failed++;
    console.error("  FAIL: get_active_input_requests returned a failure envelope");
  }
});

await run("main-only task_file_change never crosses IPC", async () => {
  const harness = makeHarness();
  const ipc = new FakeIpcMain();
  registerAgentTaskIpcHandlers(ipc, harness.service);
  const webContents = new FakeWebContents();
  const serviceEvents: AgentTaskServiceEvent[] = [];
  harness.service.onEvent((event) => serviceEvents.push(event));
  const unsubscribe = subscribeAgentTaskEventForwarding(() => webContents, harness.service);
  const { runtime } = await createSingleForegroundTask(harness);

  // Snapshot the renderer-visible messages (task creation forwards its own
  // task_state + a 1.4.2 storage_status event); the file change must add
  // nothing on any channel.
  const sentBefore = webContents.sent.length;
  runtime.emitFileChange();
  await waitFor(() => serviceEvents.some((e) => e.type === "task_file_change"), 20000, "service emitted task_file_change");

  // The event exists on the service bus (the Plan adapter consumes it inside
  // main) but no forwarding reached the renderer on either channel.
  assertEqual(webContents.sent.length, sentBefore, "no IPC message crossed for the main-only file change");
  const renderable = webContents.sent.filter((message) => message.channel === "agent-task-event").length;
  assertEqual(
    renderable,
    taskStateEvents(webContents).length + webContents.eventsOn("agent-task-event").filter((e) => (e as AgentTaskEvent).type === "storage_status").length,
    "agent-task-event only carries the task-creation task_state + storage_status events",
  );

  unsubscribe();
});

await run("P3: watch_task/unwatch_task live transitions + task_transcript forwarding", async () => {
  const harness = makeHarness();
  const ipc = new FakeIpcMain();
  registerAgentTaskIpcHandlers(ipc, harness.service);
  const webContents = new FakeWebContents();
  const unsubscribe = subscribeAgentTaskEventForwarding(() => webContents, harness.service);
  const { taskId, runtime } = await createSingleForegroundTask(harness);

  // Before watching: no transcript events cross and the runtime is not
  // forwarding (zero subscription keeps zero overhead).
  runtime.emitNestedTranscript(0, { type: "message_start", message: { role: "assistant", content: "hi" } });
  await drain();
  assert(!webContents.eventsOn("agent-task-event").some((e) => (e as AgentTaskEvent).type === "task_transcript"), "no task_transcript before watch");
  assertEqual(runtime.forwarding, false, "runtime forwarding off before watch");

  // watch_task on a running task: forwarding switches on immediately (0->1).
  const watched = (await ipc.invoke("agent-task-command", { type: "watch_task", taskId })) as PixCommandResult;
  assertEqual(watched.success, true, "watch_task succeeds on a mirror task");
  assertEqual(harness.service.isTaskWatched(taskId), true, "watcher registered");
  assertEqual(runtime.forwarding, true, "runtime forwarding enabled on watch");

  // The whitelisted nested event crosses IPC as a task_transcript.
  runtime.emitNestedTranscript(0, { type: "message_start", message: { role: "assistant", content: "live text" } });
  await waitFor(
    () => webContents.eventsOn("agent-task-event").some((e) => (e as AgentTaskEvent).type === "task_transcript"),
    20000,
    "task_transcript forwarded",
  );
  const transcript = webContents
    .eventsOn("agent-task-event")
    .find((e) => (e as AgentTaskEvent).type === "task_transcript") as Extract<AgentTaskEvent, { type: "task_transcript" }>;
  assertEqual(transcript.taskId, taskId, "task_transcript carries the taskId");
  assertEqual(transcript.itemIndex, 0, "task_transcript carries the itemIndex");
  assertEqual((transcript.event as { type: string }).type, "message_start", "task_transcript carries the nested event verbatim");

  // Counting: two watches keep streaming through one unwatch; the second
  // unwatch (1->0) switches forwarding off.
  await ipc.invoke("agent-task-command", { type: "watch_task", taskId });
  await ipc.invoke("agent-task-command", { type: "unwatch_task", taskId });
  assertEqual(harness.service.isTaskWatched(taskId), true, "still watched after one unwatch (counting)");
  await ipc.invoke("agent-task-command", { type: "unwatch_task", taskId });
  assertEqual(harness.service.isTaskWatched(taskId), false, "watcher cleared after the second unwatch");
  assertEqual(runtime.forwarding, false, "runtime forwarding off after the last unwatch");

  unsubscribe();
});

await run("P4: task_file_change crosses IPC only for watched tasks, only change", async () => {
  const harness = makeHarness();
  const ipc = new FakeIpcMain();
  registerAgentTaskIpcHandlers(ipc, harness.service);
  const webContents = new FakeWebContents();
  const unsubscribe = subscribeAgentTaskEventForwarding(() => webContents, harness.service);
  const { taskId, runtime } = await createSingleForegroundTask(harness);

  // Unwatched: the file change stays main-only (same as before S4).
  const sentBefore = webContents.sent.length;
  runtime.emitFileChange();
  await drain();
  assertEqual(webContents.sent.length, sentBefore, "unwatched file change never crosses IPC");

  // Watched: forwards exactly {taskId, change} - aggregate/planLink stripped.
  await ipc.invoke("agent-task-command", { type: "watch_task", taskId });
  runtime.emitFileChange();
  await waitFor(
    () => webContents.eventsOn("agent-task-event").some((e) => (e as AgentTaskEvent).type === "task_file_change"),
    20000,
    "watched file change forwarded",
  );
  const forwarded = webContents
    .eventsOn("agent-task-event")
    .find((e) => (e as AgentTaskEvent).type === "task_file_change") as Record<string, unknown>;
  assertEqual(forwarded.taskId, taskId, "forwarded change carries the taskId");
  assertEqual((forwarded.change as { path: string }).path, "src/a.txt", "forwarded change payload");
  assert(!("planLink" in forwarded), "planLink stripped before IPC");
  assert(!("aggregate" in forwarded), "aggregate stripped before IPC");

  unsubscribe();
});

await run("S6: get_task_log dispatch - happy path + drain barrier + not_found", async () => {
  const harness = makeHarness();
  const ipc = new FakeIpcMain();
  registerAgentTaskIpcHandlers(ipc, harness.service);
  const { taskId, runtime } = await createSingleForegroundTask(harness);

  // Happy path: the created task's log already holds its state events.
  const snap = (await ipc.invoke("agent-task-command", { type: "get_task_log", taskId })) as PixCommandResult<AgentTaskLogSnapshot>;
  assertEqual(snap.success, true, "get_task_log succeeds");
  if (snap.success === true) {
    assert("data" in snap, "data-bearing command carries data");
    assertEqual(snap.data!.taskId, taskId, "snapshot carries the taskId");
    assert(Array.isArray(snap.data!.events), "snapshot events is an array");
    assert(snap.data!.events.length >= 1, "creation state events readable");
    assertEqual(snap.data!.truncated, false, "small log is not truncated");
    assert(
      snap.data!.events.every((event) => typeof event.seq === "number" && typeof event.type === "string"),
      "events carry seq/ts/type metadata",
    );
  }

  // Drain barrier: a file_change emitted right before the read is flushed by
  // the service's getTaskLog (persist queue drained first), payload = change
  // only (single change, never the turn aggregate).
  runtime.emitFileChange();
  const afterChange = (await ipc.invoke("agent-task-command", { type: "get_task_log", taskId })) as PixCommandResult<AgentTaskLogSnapshot>;
  if (afterChange.success === true) {
    const fileChange = afterChange.data!.events.find((event) => event.type === "file_change");
    assert(fileChange !== undefined, "file_change landed in the snapshot");
    if (fileChange !== undefined) {
      assertEqual((fileChange.change as { toolCallId: string }).toolCallId, "fc-1", "change payload persisted");
      assert(!("aggregate" in fileChange), "aggregate never persisted");
    }
  }

  // Unknown task: the same not_found mapping as get_transcript.
  const unknown = (await ipc.invoke("agent-task-command", { type: "get_task_log", taskId: "no-such-task" })) as PixCommandResult;
  const unknownFailure = assertFailure(unknown, "get_task_log on an unknown task fails");
  assertEqual(unknownFailure.code, "not_found", "get_task_log not_found code");
  assertEqual(unknownFailure.error, "Agent task not found: no-such-task", "get_task_log not_found error text");
});

await run("P3: get_transcript happy path (legacy single-file fallback, cursor continuation)", async () => {
  const harness = makeHarness();
  const ipc = new FakeIpcMain();
  registerAgentTaskIpcHandlers(ipc, harness.service);
  const { taskId } = await createSingleForegroundTask(harness);
  const workspaceId = findTask(harness, taskId).workspaceId;

  // A session file with Chinese/emoji content; the task has NO item_session
  // entries, so the legacy single-file fallback maps every item to it.
  const sessionsDir = join(harness.storeRoot, workspaceId, taskId, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const lines = [
    { type: "session", id: "s1", timestamp: "2026-01-01T00:00:00Z", cwd: "E:\\proj\\demo" },
    { type: "message", id: "m1", timestamp: "2026-01-01T00:00:01Z", role: "user", content: "你好 🎉" },
    { type: "message", id: "m2", timestamp: "2026-01-01T00:00:02Z", role: "assistant", content: "第一页" },
    { type: "message", id: "m3", timestamp: "2026-01-01T00:00:03Z", role: "assistant", content: "第二页 emoji 🚀" },
  ];
  writeFileSync(join(sessionsDir, "session-a.jsonl"), lines.map((line) => `${JSON.stringify(line)}\n`).join(""));

  // Defaults: itemIndex 0, limit 200 - the whole file (header excluded).
  const page1 = (await ipc.invoke("agent-task-command", { type: "get_transcript", taskId })) as PixCommandResult<{
    taskId: string;
    itemIndex: number;
    entries: unknown[];
    totalCount: number;
    nextCursor: string | null;
    skippedLines: number;
  }>;
  assertEqual(page1.success, true, "get_transcript succeeds");
  if (page1.success === true) {
    assertEqual(page1.data!.taskId, taskId, "page carries the taskId");
    assertEqual(page1.data!.itemIndex, 0, "itemIndex defaults to 0");
    assertEqual(page1.data!.entries.length, 3, "three message entries, no header row");
    assertEqual(page1.data!.totalCount, 3, "whole-file totalCount");
    assertEqual(page1.data!.nextCursor, null, "one page covers the file");
    const first = page1.data!.entries[0] as { content: string };
    assertEqual(first.content, "你好 🎉", "multi-byte content intact");
  }

  // limit 1 + cursor continuation: the byte offset cursor resumes exactly.
  const slice1 = (await ipc.invoke("agent-task-command", {
    type: "get_transcript",
    taskId,
    itemIndex: 0,
    limit: 1,
  })) as PixCommandResult<{ entries: unknown[]; nextCursor: string | null }>;
  assertEqual(slice1.success, true, "limited page succeeds");
  if (slice1.success === true) {
    assertEqual(slice1.data!.entries.length, 1, "limit respected");
    assert(typeof slice1.data!.nextCursor === "string", "not at the end after one entry");
    const slice2 = (await ipc.invoke("agent-task-command", {
      type: "get_transcript",
      taskId,
      itemIndex: 0,
      limit: 1,
      cursor: slice1.data!.nextCursor!,
    })) as PixCommandResult<{ entries: unknown[]; nextCursor: string | null }>;
    assertEqual(slice2.success, true, "continuation page succeeds");
    if (slice2.success === true) {
      assertEqual((slice2.data!.entries[0] as { id: string }).id, "m2", "continuation resumes at the next entry");
      const slice3 = (await ipc.invoke("agent-task-command", {
        type: "get_transcript",
        taskId,
        itemIndex: 0,
        limit: 1,
        cursor: slice2.data!.nextCursor!,
      })) as PixCommandResult<{ entries: unknown[]; nextCursor: string | null }>;
      if (slice3.success === true) {
        assertEqual((slice3.data!.entries[0] as { id: string }).id, "m3", "second continuation reaches m3");
        assertEqual(slice3.data!.nextCursor, null, "final page signals the end");
      }
    }
  }

  // limit clamping: 0 -> 1, beyond 1000 -> 1000.
  const clamped = (await ipc.invoke("agent-task-command", {
    type: "get_transcript",
    taskId,
    limit: 0,
  })) as PixCommandResult<{ entries: unknown[] }>;
  if (clamped.success === true) {
    assertEqual(clamped.data!.entries.length, 1, "limit 0 clamps to 1");
  }
  const huge = (await ipc.invoke("agent-task-command", {
    type: "get_transcript",
    taskId,
    limit: 5000,
  })) as PixCommandResult<{ entries: unknown[] }>;
  if (huge.success === true) {
    assertEqual(huge.data!.entries.length, 3, "limit 5000 clamps to 1000 (file has 3)");
  }
});

await run("P3: get_transcript I/O errors are not mapped to not_found", async () => {
  const harness = makeHarness();
  const ipc = new FakeIpcMain();
  registerAgentTaskIpcHandlers(ipc, harness.service);
  const { taskId } = await createSingleForegroundTask(harness);
  const workspaceId = findTask(harness, taskId).workspaceId;

  // A malicious/escaping session file name in the log: the mapping resolves it
  // and the path guard throws. The error must surface with its original
  // message - never a not_found.
  await harness.store.appendEvent(workspaceId, taskId, {
    type: "item_session",
    itemIndex: 0,
    sessionFileName: "..\\evil.jsonl",
  });
  const result = (await ipc.invoke("agent-task-command", { type: "get_transcript", taskId, itemIndex: 0 })) as PixCommandResult;
  const failure = assertFailure(result, "escaping session file name fails the read");
  assertEqual(failure.code, "agent_task_command_failed", "I/O failure is agent_task_command_failed");
  assert(failure.error.includes("session transcript file name"), "original error message preserved");
  assert(!failure.error.includes("not_found"), "message never rewritten to not_found");
});

await run("throttled activities/output reach the renderer on agent-task-event", async () => {
  // Injectable fake clock + timers: the service's 100ms throttle merges
  // within-window emissions, and the deterministic fireAll flush proves the
  // merged events reach the renderer (waitFor's setImmediate drain never
  // yields to real timers, so real-time flushing is not used here).
  const BASE = 2_000_000;
  const fakeTimers = makeFakeTimers(BASE);
  const harness = makeHarness({ now: fakeTimers.now, setTimer: fakeTimers.setTimer, autoBackgroundMsOverride: 0 });
  const ipc = new FakeIpcMain();
  registerAgentTaskIpcHandlers(ipc, harness.service);
  const webContents = new FakeWebContents();
  const unsubscribe = subscribeAgentTaskEventForwarding(() => webContents, harness.service);
  const { runtime } = await createSingleForegroundTask(harness);

  // The first emission flushes immediately (the fake clock has never
  // advanced, so lastEmitAt=0 is far outside the window).
  runtime.emitActivity({
    sequence: 1,
    toolCallId: "call-1",
    toolName: "read",
    status: "completed",
    summary: "path-a",
    startedAt: 1,
    endedAt: 2,
  });
  await waitFor(
    () =>
      webContents
        .eventsOn("agent-task-event")
        .some((e) => (e as AgentTaskEvent).type === "task_activities"),
    20000,
    "task_activities forwarded",
  );
  const activityEvent = webContents
    .eventsOn("agent-task-event")
    .find((e) => (e as AgentTaskEvent).type === "task_activities") as Extract<AgentTaskEvent, { type: "task_activities" }>;
  assertEqual(activityEvent.taskId, runtime.spec.taskId, "activity event carries the taskId");
  assertEqual(activityEvent.activities.length, 1, "activity payload forwarded");

  // Two more activities + an output inside the same window merge into one
  // throttled flush; fireAll triggers it deterministically.
  runtime.emitActivity({
    sequence: 2,
    toolCallId: "call-2",
    toolName: "edit",
    status: "completed",
    summary: "path-b",
    startedAt: 2,
    endedAt: 3,
  });
  runtime.emitActivity({
    sequence: 3,
    toolCallId: "call-3",
    toolName: "bash",
    status: "completed",
    summary: "path-c",
    startedAt: 3,
    endedAt: 4,
  });
  runtime.emitOutput("streamed output");
  assertEqual(
    webContents.eventsOn("agent-task-event").filter((e) => (e as AgentTaskEvent).type === "task_output").length,
    0,
    "output not forwarded before the throttle flush",
  );
  fakeTimers.fireAll();
  await waitFor(
    () =>
      webContents
        .eventsOn("agent-task-event")
        .some((e) => (e as AgentTaskEvent).type === "task_output"),
    20000,
    "task_output forwarded after the flush",
  );
  const mergedActivities = webContents
    .eventsOn("agent-task-event")
    .filter((e) => (e as AgentTaskEvent).type === "task_activities") as Array<Extract<AgentTaskEvent, { type: "task_activities" }>>;
  assertEqual(mergedActivities.length, 2, "remaining activities merged into one throttled event");
  assertEqual(
    JSON.stringify(mergedActivities[1].activities.map((activity) => activity.toolCallId)),
    JSON.stringify(["call-2", "call-3"]),
    "merged event carries both activities in order",
  );
  const outputEvent = webContents
    .eventsOn("agent-task-event")
    .find((e) => (e as AgentTaskEvent).type === "task_output") as Extract<AgentTaskEvent, { type: "task_output" }>;
  assertEqual(outputEvent.taskId, runtime.spec.taskId, "output event carries the taskId");
  assertEqual(outputEvent.output, "streamed output", "output text forwarded");
  assertEqual(outputEvent.truncated, false, "truncated flag forwarded");

  unsubscribe();
});

await run("state visible within 1s of a command", async () => {
  const harness = makeHarness();
  const ipc = new FakeIpcMain();
  registerAgentTaskIpcHandlers(ipc, harness.service);
  const webContents = new FakeWebContents();
  const unsubscribe = subscribeAgentTaskEventForwarding(() => webContents, harness.service);
  const { taskId } = await createSingleForegroundTask(harness);

  const start = Date.now();
  await ipc.invoke("agent-task-command", { type: "cancel", taskId, generation: 0 });
  await waitFor(
    () => taskStateEvents(webContents).some((e) => e.task.taskId === taskId && e.task.status === "cancelled"),
    20000,
    "cancelled state forwarded",
  );
  const elapsed = Date.now() - start;
  assert(elapsed < 1000, `task state visible within 1s (${elapsed}ms)`);
  const state = taskStateEvents(webContents).find((e) => e.task.taskId === taskId && e.task.status === "cancelled")!;
  assertEqual(state.task.status, "cancelled", "cancel reaches the terminal state");
  assertEqual(state.task.generation, 0, "forwarded state carries the current generation");

  unsubscribe();
});

// ============================================================================
// 1.4.2 (R2) extensions
// ============================================================================

await run("R2: storage_status events cross IPC; snapshot carries storage statuses", async () => {
  const harness = makeHarness();
  const ipc = new FakeIpcMain();
  registerAgentTaskIpcHandlers(ipc, harness.service);
  const webContents = new FakeWebContents();
  const unsubscribe = subscribeAgentTaskEventForwarding(() => webContents, harness.service);

  await harness.service.createTaskGroup(makeParams("single", [makeTask(0)]), makeContext(harness), "foreground");

  await waitFor(
    () => webContents.eventsOn("agent-task-event").some((e) => (e as AgentTaskEvent).type === "storage_status"),
    20000,
    "storage_status event forwarded",
  );
  const storage = webContents.eventsOn("agent-task-event").find((e) => (e as AgentTaskEvent).type === "storage_status") as {
    type: "storage_status";
    status: { workspaceId: string; usedBytes: number; reservedBytes: number; limitBytes: number; level: string };
  };
  assertEqual(storage.status.level, "ok", "fresh workspace storage level is ok");
  assertEqual(storage.status.workspaceId, workspaceIdOf(PROJECT.physicalPath), "storage status keyed by workspace id");
  assert(storage.status.usedBytes > 0, "usedBytes counts the persisted task files");
  assertEqual(storage.status.limitBytes, 500 * 1024 * 1024, "limitBytes comes from the store");

  const all = (await ipc.invoke("agent-task-command", { type: "get_all" })) as PixCommandResult<{
    storageStatuses: Array<{ workspaceId: string; level: string }>;
  }>;
  assertEqual(all.success, true, "get_all succeeds after persistence");
  if (all.success === true) {
    assert(
      all.data!.storageStatuses.some((status) => status.workspaceId === storage.status.workspaceId && status.level === "ok"),
      "snapshot storage statuses mirror the emitted event",
    );
  }
  unsubscribe();
});

await run("R2: recovery_issue events cross IPC; corrupt records stay out of the task list", async () => {
  // A workspace whose task.json is unreadable produces a recovery issue, not a
  // forged AgentTaskInfo. Write the corrupt file directly through the store's
  // own writeMetadata, then corrupt it on disk.
  const storeRoot = mkdtempSync(join(tmpdir(), "pix-agent-task-ipc-store-r2-"));
  const harnessA = makeHarness(undefined, { storeRoot });
  const ipcA = new FakeIpcMain();
  registerAgentTaskIpcHandlers(ipcA, harnessA.service);

  const handle = await harnessA.service.createTaskGroup(makeParams("single", [makeTask(0)]), makeContext(harnessA), "foreground");
  const taskId = handle.tasks[0].taskId;
  const workspaceId = workspaceIdOf(PROJECT.physicalPath);
  // Wait until the metadata write landed, then corrupt task.json.
  await waitFor(
    () => existsSync(join(storeRoot, workspaceId, taskId, "task.json")),
    20000,
    "task.json written",
  );
  rmSync(join(storeRoot, workspaceId, taskId, "task.json"), { force: true });

  // A fresh service (same store root) restores; the corrupted task surfaces as
  // a recovery_issue event and never as a task. Auto-recovery is disabled to
  // keep this hydration-focused assertion isolated from the resume pass.
  const harness2 = makeHarness({ disableAutoRecovery: true }, { storeRoot });
  const ipc2 = new FakeIpcMain();
  registerAgentTaskIpcHandlers(ipc2, harness2.service);
  const webContents2 = new FakeWebContents();
  const unsubscribe2 = subscribeAgentTaskEventForwarding(() => webContents2, harness2.service);
  const report = await harness2.service.restoreAll();
  assertEqual(report.corrupted, 1, "corrupted task counted in the restore report");
  assertEqual(report.restored, 0, "no task restored from the corrupted record");

  await waitFor(
    () => webContents2.eventsOn("agent-task-event").some((e) => (e as AgentTaskEvent).type === "recovery_issue"),
    20000,
    "recovery_issue event forwarded",
  );
  const issue = webContents2.eventsOn("agent-task-event").find((e) => (e as AgentTaskEvent).type === "recovery_issue") as {
    type: "recovery_issue";
    issue: { taskId: string; workspaceId: string; generation: number; code: string; readOnly: boolean };
  };
  assertEqual(issue.issue.taskId, taskId, "recovery issue carries the task id");
  assertEqual(issue.issue.code, "migration_failed", "unreadable task.json maps to migration_failed");
  assertEqual(issue.issue.readOnly, true, "corrupt records are read-only");

  const all = (await ipc2.invoke("agent-task-command", { type: "get_all" })) as PixCommandResult<{
    tasks: unknown[];
    recoveryIssues: Array<{ taskId: string; code: string }>;
  }>;
  assertEqual(all.success, true, "get_all succeeds with recovery issues");
  if (all.success === true) {
    assertEqual(all.data!.tasks.length, 0, "corrupt task never enters the task list");
    assertEqual(all.data!.recoveryIssues.length, 1, "snapshot carries the recovery issue");
    assertEqual(all.data!.recoveryIssues[0].code, "migration_failed", "issue code in the snapshot");
  }

  // 1.5 (P1): the manual clear command is gone; the corrupt record stays as a
  // read-only diagnostic (retention never deletes recovery-corrupt records).
  const clearAttempt = (await ipc2.invoke("agent-task-command", {
    type: "clear",
    taskId,
    generation: 0,
    confirmDataLoss: true,
  })) as PixCommandResult;
  const clearFailure = assertFailure(clearAttempt, "clear command rejected");
  assertEqual(clearFailure.code, "invalid_agent_task_command", "invalid_agent_task_command code");
  const afterAttempt = (await ipc2.invoke("agent-task-command", { type: "get_all" })) as PixCommandResult<{
    recoveryIssues: unknown[];
  }>;
  if (afterAttempt.success === true) {
    assertEqual(afterAttempt.data!.recoveryIssues.length, 1, "recovery issue persists without manual clearing");
  }
  unsubscribe2();
});

// ============================================================================
// 1.4.2 (R3) diagnostics (1.5 P1: the only retained recovery command)
// ============================================================================

/** Restore an interrupted task on a real project dir (the resumer's environment check). */
async function restoreInterruptedTask(
  opts: { storeRoot: string; projectDir: string },
): Promise<{ harness: Harness; taskId: string; location: ProjectLocation }> {
  const location: ProjectLocation = {
    path: opts.projectDir,
    physicalPath: opts.projectDir,
    name: "ipc-r3",
    environment: { kind: "windows" },
  };
  const harness = makeHarness(undefined, { storeRoot: opts.storeRoot });
  const handle = await harness.service.createTaskGroup(
    makeParams("single", [makeTask(0)]),
    makeContext(harness, { project: location }),
    "foreground",
  );
  const taskId = handle.tasks[0].taskId;
  await harness.service.prepareShutdown();
  const harness2 = makeHarness(undefined, { storeRoot: opts.storeRoot });
  await harness2.service.restoreAll();
  return { harness: harness2, taskId, location };
}

await run("R3: export_diagnostics command returns metadata-only content", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "pix-ipc-diag-"));
  const storeRoot = mkdtempSync(join(tmpdir(), "pix-ipc-diag-store-"));
  const { harness, taskId } = await restoreInterruptedTask({ storeRoot, projectDir });
  const ipc = new FakeIpcMain();
  registerAgentTaskIpcHandlers(ipc, harness.service);

  const diag = (await ipc.invoke("agent-task-command", { type: "export_diagnostics", taskId })) as PixCommandResult<{
    fileName: string;
    content: string;
  }>;
  assertEqual(diag.success, true, "export_diagnostics succeeds");
  if (diag.success === true) {
    assert("data" in diag, "data-bearing command carries data");
    assertEqual(diag.data!.fileName, `agent-task-${taskId}.diagnostics.json`, "diagnostics file name");
    assert(!diag.data!.content.includes("Task prompt"), "diagnostics never include prompt text");
    assert(diag.data!.content.includes('"events"'), "diagnostics include the event metadata");
  }

  const unknown = (await ipc.invoke("agent-task-command", { type: "export_diagnostics", taskId: "no-such-task" })) as PixCommandResult;
  assertFailure(unknown, "unknown task diagnostics fail");

  rmSync(projectDir, { recursive: true, force: true });
});

// ============================================================================

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
