/**
 * AgentTask recovery tests (1.4.2 R2, design plan §5.5 / §6.4 / acceptance R2).
 *
 * Covers:
 * - service persistence: every task gets metadata + events.jsonl + checkpoint
 *   + index; restoreAll() hydrates all pre-exit non-terminal tasks as
 *   interrupted (presentation=background), keeps user_cancel cancelled,
 *   consumes clean/stale markers and reports crash shutdowns
 * - prepareShutdown: freezes pre-status + app_shutdown in the index, bounded
 *   abort (late cancelled never overwrites the freeze), matching runId close
 *   markers; emergency dispose never writes a marker
 * - storage limits: creation and runtime-time exhaustion fail the task with
 *   failed(storage_limit) and record it in the index (the readable tail)
 * - corruption: tail-corrupt events repair on restore (recoverable issue),
 *   mid-log corruption stays read-only (recovery issue, never a forged info)
 * - index write amplification: only index fields trigger index writes
 * - runtime persistence: foreground tasks write independent session JSONLs
 *   under <task>/sessions, a checkpoint follows every finalized assistant
 *   message / complete tool result / item boundary, and the workspace
 *   fingerprint is incremental (unchanged observed paths are never re-hashed;
 *   WSL batches all files + git into ONE backend bash call)
 *
 * Run with: npm exec tsx -- src/main/__tests__/agent-task-recovery.test.ts
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, posix as pathPosix, join } from "node:path";
import type { AssistantMessage, AssistantMessageEventStream, Context, Model, SimpleStreamOptions, Usage } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, type Api } from "@earendil-works/pi-ai";
import { AuthStorage, ModelRegistry, SessionManager, type ExecutionBackend } from "@earendil-works/pi-coding-agent";
import { isProductEvent, type ProductEvent } from "../../shared/product-events.js";
import {
  isAgentTaskInfo,
  type AgentTaskActivity,
  type AgentTaskInfo,
  type AgentTaskPlanLink,
  type AgentTaskSpec,
  type AgentTaskUsage,
  type ResumeDecision,
} from "../../shared/agent-task-types.js";
import type { SubagentSingleResult } from "../../shared/subagent-types.js";
import type { RequestUserInputRequest, RequestUserInputResponse } from "../../shared/types.js";
import type { ProjectLocation } from "../../shared/project-location.js";
import { SettingsStore } from "../settings-store.js";
import type { ProductEventCollector } from "../product-event-collector.js";
import type { SubagentParentRuntimeSnapshot, SubagentTaskItem } from "../subagent/types.js";
import type { AgentTaskInputRouter } from "../agent-task/agent-task-input.js";
import type { AgentTaskRuntimeResult } from "../agent-task/agent-task-runtime.js";
import { AgentTaskRuntime, RESUME_TURN_MESSAGE, __setAgentTaskRuntimeContextFactoriesForTests } from "../agent-task/agent-task-runtime.js";
import { AgentTaskResumer, RESUME_NOTE_CUSTOM_TYPE, __setAgentTaskResumerContextFactoriesForTests } from "../agent-task/agent-task-resumer.js";
import {
  AgentTaskStore,
  TaskStorageLimitError,
  type AppendEventsResult,
  type TaskCheckpoint,
  type TaskLogEvent,
  type TaskLogEventPayload,
} from "../agent-task/agent-task-store.js";
import { workspaceIdOf } from "../agent-task/agent-task-identity.js";
import {
  AgentTaskService,
  __setAgentTaskServiceHooksForTests,
  type AgentTaskServiceTestHooks,
  type AgentTaskSubmissionContext,
  type CreateTaskParams,
} from "../agent-task/agent-task-service.js";

// ============================================================================
// Test harness (matches agent-task-service.test.ts / agent-task-runtime.test.ts)
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

async function waitForAsync(condition: () => Promise<boolean>, iterations = 20000, message = "condition"): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    if (await condition()) {
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
// Shared temp environment (agentDir + project cwd) for the real-runtime tests
// ============================================================================

const AGENT_DIR = mkdtempSync(join(tmpdir(), "pix-recovery-agent-"));
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;

const MODELS_JSON = {
  providers: {
    faux: {
      baseUrl: "http://localhost:1",
      api: "faux-api",
      apiKey: "faux-key",
      models: [
        {
          id: "faux-model",
          name: "Faux Model",
          reasoning: true,
          input: ["text"],
          cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.25 },
          contextWindow: 100000,
          maxTokens: 4096,
          thinkingLevelMap: { off: null, low: "low", high: "high" },
        },
        {
          // 1.4.2 (R3): a second resolvable model for switch_model tests.
          id: "faux-model-2",
          name: "Faux Model Two",
          reasoning: true,
          input: ["text"],
          cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.25 },
          contextWindow: 100000,
          maxTokens: 4096,
          thinkingLevelMap: { off: null, low: "low", high: "high" },
        },
      ],
    },
  },
};

function writeModelsJson(): void {
  writeFileSync(join(AGENT_DIR, "models.json"), JSON.stringify(MODELS_JSON, null, 2), "utf-8");
}
writeModelsJson();

// Register the faux api ON the pi-ai instance the coding-agent dist uses, so
// nested session streamFn calls dispatch to the faux provider even though every
// runtime builds its own ModelRegistry from the same models.json on disk.
const HARNESS_AUTH = AuthStorage.create(join(AGENT_DIR, "auth.json"));
const HARNESS_REGISTRY = ModelRegistry.create(HARNESS_AUTH, join(AGENT_DIR, "models.json"));

// ============================================================================
// Faux pi-ai provider (mirrors agent-task-runtime.test.ts)
// ============================================================================

type StreamScript =
  | {
      kind: "message";
      text?: string;
      usage?: Usage;
      stopReason?: "stop" | "error" | "aborted";
      errorMessage?: string;
      toolCall?: { name: string; id: string; args: Record<string, unknown> };
    }
  | { kind: "hang"; streamText?: string; respondToAbort?: boolean; abortText?: string };

interface ProviderCall {
  model: Model<Api>;
  context: Context;
  options: SimpleStreamOptions | undefined;
  startedAt: number;
  endedAt: number | undefined;
}

function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

interface MessageOpts {
  text?: string;
  usage?: Usage;
  stopReason?: "stop" | "error" | "aborted";
  errorMessage?: string;
  toolCall?: { name: string; id: string; args: Record<string, unknown> };
}

function makeAssistantMessage(model: Model<Api>, opts: MessageOpts): AssistantMessage {
  const content: AssistantMessage["content"] = [];
  if (opts.text) {
    content.push({ type: "text", text: opts.text });
  }
  if (opts.toolCall) {
    content.push({
      type: "toolCall",
      id: opts.toolCall.id,
      name: opts.toolCall.name,
      arguments: opts.toolCall.args,
    });
  }
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: opts.usage ?? zeroUsage(),
    stopReason: opts.stopReason ?? "stop",
    errorMessage: opts.errorMessage,
    timestamp: Date.now(),
  };
}

const provider = {
  calls: [] as ProviderCall[],
  scripts: [] as StreamScript[],
  pendingHangs: [] as Array<{ stream: AssistantMessageEventStream; model: Model<Api> }>,
};

function fauxStream(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
  const call: ProviderCall = { model, context, options, startedAt: Date.now(), endedAt: undefined };
  provider.calls.push(call);

  const stream = createAssistantMessageEventStream();
  provider.pendingHangs; // (kept for parity with the runtime test harness)
  stream.result().finally(() => {
    call.endedAt = Date.now();
  });

  if (options?.signal?.aborted) {
    const aborted = makeAssistantMessage(model, { stopReason: "aborted" });
    stream.push({ type: "error", reason: "aborted", error: aborted });
    stream.end(aborted);
    return stream;
  }

  const script = provider.scripts.shift() ?? { kind: "message", text: "", stopReason: "stop" };
  if (script.kind === "hang") {
    provider.pendingHangs.push({ stream, model });
    return stream;
  }
  const message = makeAssistantMessage(model, script);
  stream.push({ type: "start", partial: message });
  if (message.content.length > 0) {
    stream.push({
      type: "text_delta",
      contentIndex: 0,
      delta: message.content[0].type === "text" ? message.content[0].text : "",
      partial: message,
    });
  }
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    stream.push({ type: "error", reason: message.stopReason, error: message });
  } else {
    stream.push({ type: "done", reason: "stop", message });
  }
  stream.end(message);
  return stream;
}

HARNESS_REGISTRY.registerProvider("faux", { api: "faux-api", streamSimple: fauxStream });

// ============================================================================
// Spec / item builders
// ============================================================================

let taskCounter = 0;

function makeLocation(physicalPath: string): ProjectLocation {
  return {
    path: physicalPath,
    physicalPath,
    name: "recovery-test",
    environment: { kind: "windows" },
  };
}

function makeSpec(projectDir: string, overrides: Partial<AgentTaskSpec> = {}): AgentTaskSpec {
  taskCounter++;
  const location = makeLocation(projectDir);
  return {
    schemaVersion: 1,
    taskId: `task-${taskCounter}`,
    groupId: `group-${taskCounter}`,
    groupMode: "single",
    mode: "single",
    items: [],
    agentScope: "user",
    thinkingLevel: "high",
    executionMode: "approval",
    verificationGate: false,
    project: location,
    workspaceId: workspaceIdOf(location.physicalPath),
    agentDir: AGENT_DIR,
    parentSessionId: "parent-session",
    parentToolCallId: "parent-tool-call",
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeReadyItem(overrides: Partial<AgentTaskSpec["items"][number]> = {}): AgentTaskSpec["items"][number] {
  return {
    resolution: "ready",
    index: 0,
    prompt: "do the thing",
    description: "A recovery test item",
    agent: {
      name: "general-purpose",
      description: "General purpose agent",
      systemPrompt: "You are a test agent.",
      source: "built-in",
    },
    model: { provider: "faux", modelId: "faux-model" },
    maxTurns: 50,
    ...overrides,
  };
}

// ============================================================================
// Structural mock for the AgentTaskInputRouter (same as agent-task-runtime.test.ts)
// ============================================================================

interface MockInputRouter {
  enqueue(taskId: string, generation: number, request: RequestUserInputRequest, signal: AbortSignal): void;
  respond(taskId: string, requestId: string, generation: number, response: RequestUserInputResponse): boolean;
  cancel(taskId: string, requestId: string, generation: number): boolean;
  settleOnShutdown(): void;
}

interface InputMockState {
  enqueued: Array<{ taskId: string; generation: number; request: RequestUserInputRequest; signal: AbortSignal }>;
  respondCalls: number;
  cancelCalls: number;
}

function makeInputMock(): { state: InputMockState; router: AgentTaskInputRouter } {
  const state: InputMockState = { enqueued: [], respondCalls: 0, cancelCalls: 0 };
  const router: MockInputRouter = {
    enqueue: (taskId, generation, request, signal) => {
      state.enqueued.push({ taskId, generation, request, signal });
    },
    respond: () => {
      state.respondCalls++;
      return true;
    },
    cancel: () => {
      state.cancelCalls++;
      return true;
    },
    settleOnShutdown: () => {},
  };
  return { state, router: router as unknown as AgentTaskInputRouter };
}

// ============================================================================
// Service-level fakes (real store, controllable runtime)
// ============================================================================

const PROJECT: ProjectLocation = {
  path: "E:\\proj\\recovery",
  physicalPath: "E:\\proj\\recovery",
  name: "recovery",
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
  acp: false,
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

type AgentTaskRuntimeEventLike =
  | { type: "activity"; activity: AgentTaskActivity }
  | { type: "output"; text: string; truncated: boolean; originalBytes: number }
  | { type: "file_change"; change: unknown; aggregate: unknown }
  | { type: "checkpoint"; checkpoint: TaskCheckpoint }
  | { type: "assistant_finalized"; entryId: string }
  | { type: "item_result"; result: SubagentSingleResult };

class FakeRuntime {
  static instances: FakeRuntime[] = [];

  readonly spec: AgentTaskSpec;
  input: AgentTaskInputRouter | undefined;
  onEvent: ((event: AgentTaskRuntimeEventLike) => void) | undefined;
  abortCalls = 0;
  disposeCalls = 0;
  private _resolveRun: ((result: AgentTaskRuntimeResult) => void) | undefined;
  settled = false;
  // 1.4.2 (R3): recorded resume seeds + prepared checkpoints.
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
    const checkpoint = (seed as { checkpoint: TaskCheckpoint }).checkpoint;
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

  emitItemResult(result: SubagentSingleResult): void {
    this.onEvent?.({ type: "item_result", result });
  }

  run(signal: AbortSignal, onEvent: (event: AgentTaskRuntimeEventLike) => void): Promise<AgentTaskRuntimeResult> {
    this.onEvent = onEvent;
    void signal;
    return new Promise<AgentTaskRuntimeResult>((resolve) => {
      this._resolveRun = resolve;
    });
  }

  emitActivity(activity: AgentTaskActivity): void {
    this.onEvent?.({ type: "activity", activity });
  }

  emitOutput(text: string): void {
    this.onEvent?.({ type: "output", text, truncated: false, originalBytes: text.length });
  }

  emitCheckpoint(partial: Partial<TaskCheckpoint> = {}): void {
    this.onEvent?.({
      type: "checkpoint",
      checkpoint: {
        taskId: this.spec.taskId,
        generation: 0,
        seq: 0,
        activeItemIndex: 0,
        sessionFileName: null,
        sessionLeafId: null,
        openToolCalls: [],
        workspaceFingerprint: { isGit: false, observedFileHashes: {} },
        ts: Date.now(),
        ...partial,
      },
    });
  }

  abort(): void {
    this.abortCalls++;
    if (!this.settled) {
      this.complete({
        status: "cancelled",
        results: this.spec.items.map((item, index) => this.makeItemResult(item, index, "aborted")),
      });
    }
  }

  complete(partial?: Partial<AgentTaskRuntimeResult>): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this._resolveRun?.({
      status: "completed",
      finalOutput: `final-${this.spec.taskId}`,
      results: this.spec.items.map((item, index) => this.makeItemResult(item, index, "completed")),
      usage: emptyUsage(),
      activities: [],
      ...partial,
    });
  }

  private makeItemResult(item: AgentTaskSpec["items"][number], index: number, status: "completed" | "aborted"): SubagentSingleResult {
    return {
      id: `fake-${this.spec.taskId}-${index}`,
      index: item.index,
      agentName: item.resolution === "ready" ? item.agent.name : item.requestedAgentName ?? "general-purpose",
      agentSource: item.resolution === "ready" ? item.agent.source : "unknown",
      description: item.description,
      status,
      finalOutput: "",
      outputTruncated: false,
      originalOutputBytes: 0,
      toolUseCount: 0,
      activities: [],
      usage: emptyUsage(),
      failureReason: status === "aborted" ? "aborted" : undefined,
      errorMessage: status === "aborted" ? "The agent task was aborted." : undefined,
      endedAt: Date.now(),
      durationMs: 0,
    };
  }

  dispose(): Promise<void> {
    this.disposeCalls++;
    return Promise.resolve();
  }

  resolveInput(): boolean {
    return false;
  }

  cancelInput(): boolean {
    return false;
  }
}

/** A store whose next appendEvents/appendEvent rejects with the injected error (tests the resume failure paths). */
class FailingAppendStore extends AgentTaskStore {
  nextAppendError: Error | undefined;

  override async appendEvents(workspaceId: string, taskId: string, events: TaskLogEventPayload[]): Promise<AppendEventsResult> {
    const injected = this.nextAppendError;
    if (injected !== undefined && events.length > 0) {
      this.nextAppendError = undefined;
      return { written: [], lastSeq: 0, failedAt: 0, error: injected };
    }
    return super.appendEvents(workspaceId, taskId, events);
  }

  override async appendEvent(workspaceId: string, taskId: string, event: TaskLogEventPayload): Promise<TaskLogEvent> {
    const injected = this.nextAppendError;
    this.nextAppendError = undefined;
    if (injected !== undefined) {
      throw injected;
    }
    return super.appendEvent(workspaceId, taskId, event);
  }
}

interface RecoveryHarness {
  service: AgentTaskService;
  store: AgentTaskStore;
  storeRoot: string;
  settings: SettingsStore;
  events: FakeCollector;
}

/**
 * Fresh service per harness: real SettingsStore + real AgentTaskStore on a
 * fresh (or shared) root + fake runtimes, auto-background disabled.
 */
function makeRecoveryHarness(
  opts: {
    storeRoot?: string;
    maxTaskBytes?: number;
    maxWorkspaceBytes?: number;
    reserveBytesOverride?: number;
    store?: AgentTaskStore;
    autoRecovery?: boolean;
    retentionOverride?: AgentTaskServiceTestHooks["retentionOverride"];
  } = {},
): RecoveryHarness {
  FakeRuntime.instances = [];
  const settings = new SettingsStore({ cwd: mkdtempSync(join(tmpdir(), "pix-recovery-settings-")) });
  settings.set("enableProductAnalytics", true);
  const events = new FakeCollector() as unknown as ProductEventCollector;
  const storeRoot = opts.storeRoot ?? mkdtempSync(join(tmpdir(), "pix-recovery-store-"));
  const store =
    opts.store ??
    new AgentTaskStore({
      rootDir: storeRoot,
      maxTaskBytes: opts.maxTaskBytes ?? 25 * 1024 * 1024,
      maxWorkspaceBytes: opts.maxWorkspaceBytes ?? 500 * 1024 * 1024,
    });
  const service = new AgentTaskService({ settings, events, store, runId: "recovery-run" });
  const hooks: Partial<AgentTaskServiceTestHooks> = {
    autoBackgroundMsOverride: 0,
    flushIndexWrites: true,
    // 1.5 (P1): this suite targets hydration semantics and the explicit
    // resume/markFailed flows; the automatic post-restoreAll pass has its own
    // dedicated tests (opt back in with opts.autoRecovery).
    ...(opts.autoRecovery ? {} : { disableAutoRecovery: true }),
    runtimeFactory: (spec, input) => {
      const fake = new FakeRuntime(spec);
      fake.input = input;
      return fake as unknown as AgentTaskRuntime;
    },
    ...(opts.reserveBytesOverride !== undefined ? { reserveBytesOverride: opts.reserveBytesOverride } : {}),
    ...(opts.retentionOverride !== undefined ? { retentionOverride: opts.retentionOverride } : {}),
  };
  __setAgentTaskServiceHooksForTests(hooks);
  return { service, store, storeRoot, settings, events };
}

function makeContext(harness: RecoveryHarness, overrides?: Partial<AgentTaskSubmissionContext>): AgentTaskSubmissionContext {
  const loaded = {
    agents: [
      {
        name: "general-purpose",
        description: "General purpose",
        systemPrompt: "You are a general purpose agent.",
        source: "built-in",
      },
    ],
    projectAgentsDir: "E:\\proj\\recovery\\.pi\\agents",
    diagnostics: [],
  };
  return {
    parentSessionId: "session-1",
    parentToolCallId: "tool-call-1",
    project: { ...PROJECT },
    agentDir: AGENT_DIR,
    loadedAgents: loaded as never,
    modelRegistry: {
      getAll: () => [makeModel("alpha", "faux")],
      find: (provider: string, modelId: string) =>
        provider === "faux" && modelId === "alpha" ? makeModel(modelId, "faux") : undefined,
      hasConfiguredAuth: () => true,
    } as never,
    parentRuntime: { ...PARENT_RUNTIME },
    requestUserInput: async () => ({ id: "unused", answers: {}, cancelled: true }),
    hostDisposed: new Promise(() => {}),
    ...overrides,
  };
}

function makeParams(mode: "single" | "parallel" | "chain", tasks: SubagentTaskItem[], overrides?: Partial<CreateTaskParams>): CreateTaskParams {
  return {
    mode,
    agentScope: "user",
    tasks,
    runInBackground: false,
    ...overrides,
  };
}

function findTask(harness: RecoveryHarness, taskId: string): AgentTaskInfo {
  const task = harness.service.getAll().tasks.find((info) => info.taskId === taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }
  return task;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf-8"));
}

// ============================================================================
// Service-level recovery tests
// ============================================================================

await run("restoreAll: a crash-restored running task hydrates interrupted; markers report crash", async () => {
  const harness = makeRecoveryHarness();
  const handle = await harness.service.createTaskGroup(makeParams("parallel", [makeTask(0), makeTask(1)]), makeContext(harness), "foreground");
  const taskIds = handle.tasks.map((task) => task.taskId);
  const first = FakeRuntime.instances[0];
  first.emitActivity({
    sequence: 1,
    toolCallId: "call-1",
    toolName: "read",
    status: "completed",
    summary: "src/a.ts",
    startedAt: Date.now(),
    endedAt: Date.now() + 1,
  });
  first.emitOutput("partial output");
  first.emitCheckpoint({ sessionFileName: "sess.jsonl", sessionLeafId: "leaf-1", openToolCalls: [] });
  // Wait until the log tail actually landed (the persistence flush does disk
  // I/O; a single setImmediate drain can race it).
  await waitForAsync(
    async () => {
      try {
        const raw = await readFile(join(harness.storeRoot, workspaceIdOf(PROJECT.physicalPath), taskIds[0], "events.jsonl"), "utf-8");
        return raw.includes("partial output");
      } catch {
        return false;
      }
    },
    20000,
    "output event persisted",
  );

  // A "crash": the next app start builds a fresh service on the same store
  // without any marker (no prepareShutdown, no dispose).
  const harness2 = makeRecoveryHarness({ storeRoot: harness.storeRoot });
  const report = await harness2.service.restoreAll();
  assertEqual(report.restored, 2, "both tasks restored");
  assertEqual(report.interrupted, 2, "both non-terminal tasks hydrated as interrupted");
  assert(report.diagnostics.some((d) => d.includes("crash")), "no marker -> crash diagnosis");
  const snap = harness2.service.getAll();
  assertEqual(snap.tasks.length, 2, "snapshot lists both tasks");
  for (const info of snap.tasks) {
    assert(isAgentTaskInfo(info), "restored task passes isAgentTaskInfo");
    assertEqual(info.status, "interrupted", "crash-restored task is interrupted");
    assertEqual(info.presentation, "background", "hydrated interrupted tasks are background");
    assertEqual(info.stopReason, "app_shutdown", "hydrated stopReason is app_shutdown");
    assertEqual(info.autoBackground, undefined, "hydrated tasks clear autoBackground");
    assertEqual(info.queuePosition, undefined, "hydrated tasks clear queuePosition");
  }
  // The readable tail survived: activities + output replayed from the log.
  const restoredFirst = snap.tasks.find((info) => info.taskId === taskIds[0])!;
  assertEqual(restoredFirst.finalOutput, "partial output", "output tail restored from the log");
  assertEqual(restoredFirst.activities.length, 1, "activity restored from the log");
  assert(harness2.events.records.some((e) => e.name === "agent_task_interrupted"), "agent_task_interrupted recorded");
  assert(harness2.events.records.some((e) => e.name === "agent_task_restored"), "agent_task_restored recorded");

  // get_all carries the snapshot with storage statuses.
  assert(snap.storageStatuses.some((status) => status.workspaceId === workspaceIdOf(PROJECT.physicalPath)), "snapshot carries the workspace storage status");
  assertEqual(snap.recoveryIssues.length, 0, "no recovery issues for healthy tasks");
});

await run("restoreAll: completed tasks stay terminal; user_cancel keeps cancelled; clean marker consumed", async () => {
  const harness = makeRecoveryHarness();
  const handle = await harness.service.createTaskGroup(makeParams("parallel", [makeTask(0), makeTask(1)]), makeContext(harness), "foreground");
  const [taskIdA, taskIdB] = handle.tasks.map((task) => task.taskId);

  // Task A completes normally.
  FakeRuntime.instances.find((fake) => fake.spec.taskId === taskIdA)!.complete();
  await waitFor(() => findTask(harness, taskIdA).status === "completed", 20000, "task A completed");

  // Task B is cancelled by the user (terminal cancelled + user_cancel).
  await harness.service.cancel(taskIdB, 0, "user_cancel");
  await waitFor(() => findTask(harness, taskIdB).status === "cancelled", 20000, "task B cancelled");
  assertEqual(findTask(harness, taskIdB).stopReason, "user_cancel", "user-cancelled task carries user_cancel");

  // Clean shutdown: freeze is a no-op for terminal tasks; marker written.
  await harness.service.prepareShutdown();
  const markerPath = join(harness.storeRoot, workspaceIdOf(PROJECT.physicalPath), "close-marker.json");
  assert(existsSync(markerPath), "close marker written by prepareShutdown");
  const marker = (await readJson(markerPath)) as { runId: string };
  assertEqual(marker.runId, "recovery-run", "marker carries the frozen runId");

  const harness2 = makeRecoveryHarness({ storeRoot: harness.storeRoot });
  const report = await harness2.service.restoreAll();
  assert(report.diagnostics.some((d) => d.includes("clean")), "matching runId marker -> clean diagnosis");
  assertEqual(report.interrupted, 0, "no interrupted tasks");
  const snap = harness2.service.getAll();
  const a = snap.tasks.find((info) => info.taskId === taskIdA)!;
  const b = snap.tasks.find((info) => info.taskId === taskIdB)!;
  assertEqual(a.status, "completed", "completed task restores completed");
  assertEqual(b.status, "cancelled", "user_cancel keeps cancelled");
  assert(!existsSync(markerPath), "marker consumed and removed at restore");
});

await run("prepareShutdown: freezes pre-status + app_shutdown, bounded abort never overwrites, marker matching", async () => {
  const harness = makeRecoveryHarness();
  const handle = await harness.service.createTaskGroup(makeParams("parallel", [makeTask(0), makeTask(1), makeTask(2), makeTask(3), makeTask(4)]), makeContext(harness), "foreground");
  const taskIds = handle.tasks.map((task) => task.taskId);
  const queuedId = handle.tasks.find((task) => task.status === "queued")!.taskId;

  await harness.service.prepareShutdown();
  // The freeze persisted: the index records preShutdownStatus + app_shutdown
  // for every non-terminal task, and the late abort-cancelled settles are
  // suppressed (statuses stay frozen).
  await drain();
  const ws = workspaceIdOf(PROJECT.physicalPath);
  const index = (await readJson(join(harness.storeRoot, ws, "index.json"))) as {
    lastWriterRunId: string;
    tasks: Array<{ taskId: string; status: string; preShutdownStatus: string; stopReason: string; lastWriterRunId: string }>;
  };
  assertEqual(index.lastWriterRunId, "recovery-run", "index carries the frozen runId");
  const frozenRunning = index.tasks.filter((entry) => entry.taskId !== queuedId);
  assertEqual(frozenRunning.length, 4, "four running tasks in the index");
  assert(frozenRunning.every((entry) => entry.preShutdownStatus === "running"), "preShutdownStatus frozen to running");
  assert(frozenRunning.every((entry) => entry.stopReason === "app_shutdown"), "stopReason frozen to app_shutdown");
  const frozenQueued = index.tasks.find((entry) => entry.taskId === queuedId)!;
  assertEqual(frozenQueued.preShutdownStatus, "queued", "queued task frozen as queued");

  // The abort settled as cancelled in the fake; the frozen fact was not
  // overwritten in memory.
  assert(FakeRuntime.instances.every((fake) => fake.abortCalls > 0), "every runtime aborted by prepareShutdown");
  await waitFor(
    () => harness.service.getAll().tasks.every((info) => info.status === "running" || info.status === "queued"),
    20000,
    "late cancelled never overwrites the frozen pre-status",
  );

  // A clean restart hydrates everything non-terminal as interrupted.
  const harness2 = makeRecoveryHarness({ storeRoot: harness.storeRoot });
  const report = await harness2.service.restoreAll();
  assert(report.diagnostics.some((d) => d.includes("clean")), "clean diagnosis on restart");
  assertEqual(report.interrupted, 5, "all five pre-shutdown tasks hydrate interrupted");
  assert(harness2.service.getAll().tasks.every((info) => info.status === "interrupted"), "all restored tasks interrupted");
});

await run("dispose without prepareShutdown never writes a clean marker", async () => {
  const harness = makeRecoveryHarness();
  await harness.service.createTaskGroup(makeParams("single", [makeTask(0)]), makeContext(harness), "foreground");
  await harness.service.dispose("app_shutdown");
  const markerPath = join(harness.storeRoot, workspaceIdOf(PROJECT.physicalPath), "close-marker.json");
  assert(!existsSync(markerPath), "emergency dispose writes no clean marker");
  // The on-disk state stays the pre-exit non-terminal facts -> interrupted.
  const harness2 = makeRecoveryHarness({ storeRoot: harness.storeRoot });
  const report = await harness2.service.restoreAll();
  assertEqual(report.interrupted, 1, "emergency-disposed task hydrates interrupted");
});

await run("retention deletion rewrites the persisted index: deleted tasks never resurrect as recovery-corrupt after restart", async () => {
  const harness = makeRecoveryHarness();
  const handle = await harness.service.createTaskGroup(makeParams("parallel", [makeTask(0), makeTask(1)]), makeContext(harness), "foreground");
  const [taskA, taskB] = handle.tasks.map((task) => task.taskId);
  FakeRuntime.instances.find((fake) => fake.spec.taskId === taskA)!.complete();
  FakeRuntime.instances.find((fake) => fake.spec.taskId === taskB)!.complete();
  await waitFor(
    () => findTask(harness, taskA).status === "completed" && findTask(harness, taskB).status === "completed",
    20000,
    "both tasks completed",
  );
  // Drain the first harness's flush queue (terminal persistence + its own
  // default-window retention pass) BEFORE the global test hooks switch to the
  // tiny retention window: a pass scheduled here but executed later would read
  // the NEW hooks and race the second harness over the shared store root.
  // prepareShutdown only freezes non-terminal tasks - both are terminal here -
  // and its final drain quiesces the queue deterministically.
  await harness.service.prepareShutdown();
  const ws = workspaceIdOf(PROJECT.physicalPath);

  // 1.5 (P1): a restart with a tiny injected retention window (keep nothing)
  // deletes exactly the terminal records and rewrites the persisted index -
  // the retention pass replaces the removed manual clear.
  const harness2 = makeRecoveryHarness({
    storeRoot: harness.storeRoot,
    retentionOverride: { keepCount: 0, keepAgeMs: 0, undeliveredGraceMs: 0 },
  });
  const report = await harness2.service.restoreAll();
  assertEqual(report.restored, 2, "both terminal tasks hydrated before retention");
  // The retention pass chains onto the persistence flush queue and performs
  // several sequential fs operations (record delete + index rewrite); the
  // suite's iteration-budget waitFor drains microtasks too fast for real IO,
  // so poll on wall-clock instead.
  const retentionDeadline = Date.now() + 10_000;
  while (harness2.service.getAll().tasks.length > 0) {
    if (Date.now() > retentionDeadline) {
      throw new Error("Timed out waiting for retention removed both terminal tasks");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const index = await harness2.store.readIndex(ws);
  assert(index !== null, "index exists after the retention deletion");
  assertEqual(index?.tasks.length, 0, "empty entries array written");

  // Restart: no tasks, no recovery issues, corrupted == 0 (the old bug
  // re-surfaced every deleted task as a migration_failed recovery issue).
  const harness3 = makeRecoveryHarness({ storeRoot: harness.storeRoot });
  const report3 = await harness3.service.restoreAll();
  assertEqual(report3.restored, 0, "no tasks restored after restart");
  assertEqual(report3.corrupted, 0, "no recovery-corrupt records after restart");
  const snap = harness3.service.getAll();
  assertEqual(snap.tasks.length, 0, "no tasks after restart");
  assertEqual(snap.recoveryIssues.length, 0, "no recovery issues after restart");
});

await run("recovery-corrupt records persist as read-only diagnostics (no manual clear)", async () => {
  // A workspace whose task.json is unreadable produces a recovery issue. 1.5
  // (P1): the issue-clear command is gone and retention never deletes
  // recovery-corrupt records, so the diagnostic persists read-only across
  // restarts instead of being silently removable.
  const harness = makeRecoveryHarness();
  const handle = await harness.service.createTaskGroup(makeParams("single", [makeTask(0)]), makeContext(harness), "foreground");
  const taskId = handle.tasks[0].taskId;
  const ws = workspaceIdOf(PROJECT.physicalPath);
  await waitFor(() => existsSync(join(harness.storeRoot, ws, taskId, "task.json")), 20000, "task.json written");
  rmSync(join(harness.storeRoot, ws, taskId, "task.json"), { force: true });

  const harness2 = makeRecoveryHarness({ storeRoot: harness.storeRoot });
  const report = await harness2.service.restoreAll();
  assertEqual(report.corrupted, 1, "unreadable record surfaces as corrupted");

  // Restart again: the same read-only diagnostic resurfaces (nothing deletes
  // it automatically and no manual command exists).
  const harness3 = makeRecoveryHarness({ storeRoot: harness.storeRoot });
  const report3 = await harness3.service.restoreAll();
  assertEqual(report3.corrupted, 1, "recovery-corrupt record persists across restarts");
  const issues = harness3.service.getAll().recoveryIssues;
  assertEqual(issues.length, 1, "the read-only diagnostic stays visible");
  assertEqual(issues[0].readOnly, true, "the diagnostic stays read-only");
});

await run("restoreAll: rebuilt groups enable Plan two-phase consumption (terminal chain/parallel groups, interrupted release, resumed completion)", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "pix-restore-group-"));
  const location = makeLocation(projectDir);
  const link: AgentTaskPlanLink = { planId: "plan-1", version: 1, stepId: "step-0" };
  const harness = makeRecoveryHarness();

  // chain group (single task) + parallel group (two children) complete before
  // shutdown; two single groups stay running and hydrate interrupted.
  const chainHandle = await harness.service.createTaskGroup(
    makeParams("chain", [makeTask(0), makeTask(1)], { planLink: link }),
    makeContext(harness, { project: location }),
    "foreground",
  );
  const parallelHandle = await harness.service.createTaskGroup(
    makeParams("parallel", [makeTask(2), makeTask(3)], { planLink: link }),
    makeContext(harness, { project: location }),
    "foreground",
  );
  const releaseHandle = await harness.service.createTaskGroup(
    makeParams("single", [makeTask(4)], { planLink: link }),
    makeContext(harness, { project: location }),
    "foreground",
  );
  const resumeHandle = await harness.service.createTaskGroup(
    makeParams("single", [makeTask(5)], { planLink: link }),
    makeContext(harness, { project: location }),
    "foreground",
  );
  const chainTaskId = chainHandle.tasks[0].taskId;
  const [parA, parB] = parallelHandle.tasks.map((task) => task.taskId);
  const releaseTaskId = releaseHandle.tasks[0].taskId;
  const resumeTaskId = resumeHandle.tasks[0].taskId;

  FakeRuntime.instances.find((fake) => fake.spec.taskId === chainTaskId)!.complete();
  await waitFor(() => findTask(harness, chainTaskId).status === "completed", 20000, "chain task completed");
  FakeRuntime.instances.find((fake) => fake.spec.taskId === parA)!.complete();
  FakeRuntime.instances.find((fake) => fake.spec.taskId === parB)!.complete();
  await waitFor(
    () => findTask(harness, parA).status === "completed" && findTask(harness, parB).status === "completed",
    20000,
    "parallel tasks completed",
  );
  await harness.service.prepareShutdown();

  const harness2 = makeRecoveryHarness({ storeRoot: harness.storeRoot });
  await harness2.service.restoreAll();
  assertEqual(findTask(harness2, releaseTaskId).status, "interrupted", "running task hydrates interrupted");
  assertEqual(findTask(harness2, resumeTaskId).status, "interrupted", "second running task hydrates interrupted");

  // Terminal restored groups are directly consumable (chain + parallel).
  const chainResult = await harness2.service.getPlanTaskGroupResult(chainHandle.groupId, link);
  assertEqual(chainResult.ok, true, "restored chain group result readable");
  if (chainResult.ok) {
    assertEqual(chainResult.status, "completed", "restored chain group completed");
    assertEqual(chainResult.taskIds.length, 1, "chain group lists its single task");
  }
  const parallelResult = await harness2.service.getPlanTaskGroupResult(parallelHandle.groupId, link);
  assertEqual(parallelResult.ok, true, "restored parallel group result readable");
  if (parallelResult.ok) {
    assertEqual(parallelResult.status, "completed", "restored parallel group completed");
    assertEqual(parallelResult.taskIds.length, 2, "parallel group lists both children");
    assert(parallelResult.summary.includes(parA) && parallelResult.summary.includes(parB), "parallel summary lists every task/status");
  }

  // Interrupted restored groups are not terminal until resumed.
  const beforeResume = await harness2.service.getPlanTaskGroupResult(resumeHandle.groupId, link);
  assertEqual(beforeResume.ok, false, "interrupted restored group not terminal");
  if (!beforeResume.ok) {
    assertEqual(beforeResume.reason, "group_not_terminal", "group_not_terminal reason");
  }

  // Consumption on a restored group: pending -> consumed.
  await harness2.service.confirmPlanTaskGroupConsumed(chainHandle.groupId, link);
  assertEqual(findTask(harness2, chainTaskId).planLinkState, "consumed", "restored group consumption flips pending -> consumed");

  // Release on a restored interrupted group: pending -> released (previously
  // a permanent pending zombie).
  await harness2.service.releasePlanTaskGroup(releaseHandle.groupId, link, "plan_cancelled");
  assertEqual(findTask(harness2, releaseTaskId).planLinkState, "released", "restored release flips pending -> released");

  // A resumed restored group becomes consumable after completion.
  const resumeResult = await harness2.service.resume(resumeTaskId, 0, { action: "continue", confirmWorkspaceChanges: true });
  assertEqual(resumeResult.ok, true, "restored interrupted task resumes");
  FakeRuntime.instances.find((fake) => fake.spec.taskId === resumeTaskId)!.complete();
  await waitFor(() => findTask(harness2, resumeTaskId).status === "completed", 20000, "resumed task completed");
  const afterResume = await harness2.service.getPlanTaskGroupResult(resumeHandle.groupId, link);
  assertEqual(afterResume.ok, true, "resumed restored group result readable");
  if (afterResume.ok) {
    assertEqual(afterResume.status, "completed", "resumed restored group completed");
  }
  await harness2.service.confirmPlanTaskGroupConsumed(resumeHandle.groupId, link);
  assertEqual(findTask(harness2, resumeTaskId).planLinkState, "consumed", "resumed restored consumption works");

  rmSync(projectDir, { recursive: true, force: true });
});

await run("restoreAll: a terminal log state beats a stale non-terminal index (crash between event append and index rewrite)", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "pix-log-terminal-"));
  const spec = makeSpec(projectDir, { items: [makeReadyItem()] });
  const storeRoot = mkdtempSync(join(tmpdir(), "pix-log-terminal-store-"));
  const store = new AgentTaskStore({
    rootDir: storeRoot,
    maxTaskBytes: 25 * 1024 * 1024,
    maxWorkspaceBytes: 500 * 1024 * 1024,
  });
  const ws = spec.workspaceId;
  await store.initWorkspace(ws);
  const completed = makeInfo(spec, {
    status: "completed",
    endedAt: Date.now(),
    finalOutput: "done",
    results: [
      {
        id: "r-1",
        index: 0,
        agentName: "general-purpose",
        agentSource: "built-in",
        description: "A recovery test item",
        status: "completed",
        finalOutput: "ok",
        outputTruncated: false,
        originalOutputBytes: 0,
        toolUseCount: 0,
        activities: [],
        usage: emptyUsage(),
        endedAt: Date.now(),
        durationMs: 10,
      },
    ],
  });
  await store.writeMetadata(ws, spec.taskId, { schemaVersion: 1, spec, initialInfo: makeInfo(spec, { status: "queued" }) });
  await store.appendEvent(ws, spec.taskId, { type: "state", from: "running", to: "completed", info: completed });
  const cp = makeDefaultCheckpoint(spec);
  await store.writeCheckpoint(ws, spec.taskId, cp);
  // The index still carries the pre-crash non-terminal status: the crash hit
  // between the terminal event append and the index rewrite.
  await store.writeIndex(ws, {
    schemaVersion: 1,
    workspaceId: ws,
    generation: 1,
    lastWriterRunId: "test-run",
    tasks: [
      {
        taskId: spec.taskId,
        workspaceId: ws,
        parentSessionId: spec.parentSessionId,
        parentToolCallId: spec.parentToolCallId,
        groupId: spec.groupId,
        status: "running",
        lastCheckpointSeq: cp.seq,
        hasUnclosedToolCall: false,
        updatedAt: Date.now(),
        schemaVersion: 1,
        lastWriterRunId: "test-run",
      },
    ],
  });

  const harness = makeRecoveryHarness({ storeRoot });
  const report = await harness.service.restoreAll();
  assertEqual(report.interrupted, 0, "log-terminal task is not resurrected as interrupted");
  const task = harness.service.getAll().tasks.find((t) => t.taskId === spec.taskId);
  assert(task !== undefined, "log-terminal task hydrates");
  assertEqual(task?.status, "completed", "terminal log status wins over the stale index");
  assertEqual(task?.results.length, 1, "completed results restored from the log snapshot");
  assertEqual(task?.finalOutput, "done", "final output restored from the log snapshot");
  assertEqual(task?.planLinkState, "none", "no forged plan link on the unlinked task");

  rmSync(projectDir, { recursive: true, force: true });
});

await run("restoreAll: an index-terminal status with a non-terminal log synthesizes the terminal invariants (§4.4)", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "pix-index-terminal-"));
  const spec = makeSpec(projectDir, { items: [makeReadyItem()] });
  const storeRoot = mkdtempSync(join(tmpdir(), "pix-index-terminal-store-"));
  const store = new AgentTaskStore({
    rootDir: storeRoot,
    maxTaskBytes: 25 * 1024 * 1024,
    maxWorkspaceBytes: 500 * 1024 * 1024,
  });
  const ws = spec.workspaceId;
  await store.initWorkspace(ws);
  // The log's last state event is non-terminal (running): the terminal state
  // event was lost to the storage budget. The index (never budget-checked)
  // recorded the terminal status.
  await store.writeMetadata(ws, spec.taskId, { schemaVersion: 1, spec, initialInfo: makeInfo(spec, { status: "queued" }) });
  await store.appendEvent(ws, spec.taskId, { type: "state", from: "queued", to: "running", info: makeInfo(spec, { status: "running" }) });
  await store.writeCheckpoint(ws, spec.taskId, makeDefaultCheckpoint(spec, { generation: 0 }));
  const terminalUpdatedAt = Date.now();
  await store.writeIndex(ws, {
    schemaVersion: 1,
    workspaceId: ws,
    generation: 1,
    lastWriterRunId: "test-run",
    tasks: [
      {
        taskId: spec.taskId,
        workspaceId: ws,
        parentSessionId: spec.parentSessionId,
        parentToolCallId: spec.parentToolCallId,
        groupId: spec.groupId,
        status: "failed",
        lastCheckpointSeq: 0,
        hasUnclosedToolCall: false,
        updatedAt: terminalUpdatedAt,
        schemaVersion: 1,
        lastWriterRunId: "test-run",
      },
    ],
  });

  const harness = makeRecoveryHarness({ storeRoot });
  const report = await harness.service.restoreAll();
  assertEqual(report.corrupted, 0, "index-terminal task is not corrupted");
  const task = harness.service.getAll().tasks.find((t) => t.taskId === spec.taskId);
  assert(task !== undefined, "index-terminal task hydrates");
  assertEqual(task?.status, "failed", "index terminal status supplies the status");
  assert(isAgentTaskInfo(task), "the hydrated info passes isAgentTaskInfo (terminal invariants synthesized)");
  assert(task !== undefined && task.endedAt !== undefined, "terminal endedAt synthesized");
  assertEqual(task?.endedAt, terminalUpdatedAt, "endedAt comes from the index updatedAt");
  assert(task?.autoBackground === undefined, "terminal autoBackground cleared");
  assert(task?.queuePosition === undefined, "terminal queuePosition cleared");
  assert(task?.failureReason !== undefined, "failed carries a synthesized failureReason");
  assertEqual(task?.failureReason, "internal_error", "synthesized failureReason is internal_error");
  assert(task?.errorMessage !== undefined && (task?.errorMessage ?? "").includes("log tail was lost"), "synthesized errorMessage explains the lost tail");

  rmSync(projectDir, { recursive: true, force: true });
});

await run("storage limit at creation: failed(storage_limit), index records the failure", async () => {
  const harness = makeRecoveryHarness({ maxTaskBytes: 2048, maxWorkspaceBytes: 2048 * 2, reserveBytesOverride: 1 });
  const handle = await harness.service.createTaskGroup(makeParams("single", [makeTask(0)]), makeContext(harness), "foreground");
  const taskId = handle.tasks[0].taskId;
  await waitFor(() => findTask(harness, taskId).status === "failed", 20000, "task failed on the tiny budget");
  const info = findTask(harness, taskId);
  assertEqual(info.failureReason, "storage_limit", "failure reason is storage_limit");
  assertEqual(info.results[0].failureReason, "storage_limit", "synthesized result carries storage_limit");

  // The index (unchecked by budget) records the failure, but the task never
  // got a readable record (the metadata write itself was blocked by the
  // budget). A restart therefore surfaces an honest, clearable recovery issue
  // - never a forged AgentTaskInfo, never a wrongly hydrated interrupted task.
  const harness2 = makeRecoveryHarness({ storeRoot: harness.storeRoot, maxTaskBytes: 2048, maxWorkspaceBytes: 2048 * 2, reserveBytesOverride: 1 });
  const report = await harness2.service.restoreAll();
  assertEqual(report.interrupted, 0, "storage-failed task is not hydrated as interrupted");
  const snap = harness2.service.getAll();
  assertEqual(snap.tasks.length, 0, "no forged task for the never-persisted record");
  const issue = snap.recoveryIssues.find((candidate) => candidate.taskId === taskId);
  assert(issue !== undefined, "storage-failed task surfaces as a recovery issue");
  assertEqual(issue?.code, "migration_failed", "unreadable metadata maps to migration_failed");
  assertEqual(issue?.readOnly, true, "unreadable record is read-only");
});

await run("runtime storage limit: oversized output fails the task with storage_limit", async () => {
  // Big enough for creation (~4KB metadata + initial events), small enough
  // that a large output event exceeds the budget during the run.
  const harness = makeRecoveryHarness({ maxTaskBytes: 6000, maxWorkspaceBytes: 6000 * 2, reserveBytesOverride: 0 });
  const handle = await harness.service.createTaskGroup(makeParams("single", [makeTask(0)]), makeContext(harness), "foreground");
  const taskId = handle.tasks[0].taskId;
  const fake = FakeRuntime.instances[0];
  fake.emitOutput("x".repeat(5000));
  await waitFor(() => findTask(harness, taskId).status === "failed", 20000, "task failed after the oversized output");
  const info = findTask(harness, taskId);
  assertEqual(info.failureReason, "storage_limit", "runtime storage_limit failure");
  assertEqual(info.errorMessage !== undefined, true, "failure carries a message");
  // The readable tail is preserved: the log still holds the initial state.
  const read = await harness.store.readTask(workspaceIdOf(PROJECT.physicalPath), taskId);
  assert(read.events.length >= 1, "readable tail preserved");
});

await run("events.jsonl tail corruption: task restores from the valid prefix + recoverable issue", async () => {
  const harness = makeRecoveryHarness();
  const handle = await harness.service.createTaskGroup(makeParams("single", [makeTask(0)]), makeContext(harness), "foreground");
  const taskId = handle.tasks[0].taskId;
  const ws = workspaceIdOf(PROJECT.physicalPath);
  await waitFor(() => existsSync(join(harness.storeRoot, ws, taskId, "events.jsonl")), 20000, "events.jsonl written");
  await harness.service.cancel(taskId, 0, "user_cancel");
  await waitFor(() => findTask(harness, taskId).status === "cancelled", 20000, "task cancelled");
  // Wait until the cancelled state + index durably landed before corrupting.
  await waitForAsync(
    async () => {
      try {
        const index = (await readJson(join(harness.storeRoot, ws, "index.json"))) as { tasks: Array<{ status: string; stopReason: string }> };
        return index.tasks[0]?.status === "cancelled" && index.tasks[0]?.stopReason === "user_cancel";
      } catch {
        return false;
      }
    },
    20000,
    "index records the cancelled state",
  );

  // Truncate the final line (crash signature: no trailing newline, partial JSON).
  const eventsPath = join(harness.storeRoot, ws, taskId, "events.jsonl");
  // The cancelled state event must be the LAST write: wait until the file is
  // stable (no harness flush is still in flight) before appending the tail.
  await waitForAsync(async () => {
    const first = readFileSync(eventsPath, "utf-8");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    return readFileSync(eventsPath, "utf-8") === first;
  }, 200, "events.jsonl stable before corruption");
  await writeFile(eventsPath, readFileSync(eventsPath, "utf-8") + '{"seq":999,"type":"state","from":"running","to":"cancelled","info":{}', "utf-8");

  const harness2 = makeRecoveryHarness({ storeRoot: harness.storeRoot });
  const report = await harness2.service.restoreAll();
  assertEqual(report.restored, 1, "task restored from the valid prefix");
  assertEqual(report.corrupted, 0, "tail corruption is not a lost task");
  const snap = harness2.service.getAll();
  assertEqual(snap.recoveryIssues.length, 1, "tail_corrupt recovery issue surfaced");
  const issue = snap.recoveryIssues[0];
  assertEqual(issue.code, "tail_corrupt", "tail_corrupt code");
  assertEqual(issue.recoverable, true, "tail corruption is repairable");
  assertEqual(issue.readOnly, false, "tail-corrupt task stays writable");
  assertEqual(snap.tasks.length, 1, "the task itself is still listed");
  assertEqual(snap.tasks[0].status, "cancelled", "user_cancel stays cancelled despite the tail");
});

await run("events.jsonl mid-log corruption: read-only recovery issue, never a forged task", async () => {
  const harness = makeRecoveryHarness();
  const handle = await harness.service.createTaskGroup(makeParams("single", [makeTask(0)]), makeContext(harness), "foreground");
  const taskId = handle.tasks[0].taskId;
  const ws = workspaceIdOf(PROJECT.physicalPath);
  await waitFor(() => existsSync(join(harness.storeRoot, ws, taskId, "events.jsonl")), 20000, "events.jsonl written");

  // Break a line in the middle of the log.
  const eventsPath = join(harness.storeRoot, ws, taskId, "events.jsonl");
  const lines = readFileSync(eventsPath, "utf-8").split("\n").filter((line) => line.trim() !== "");
  lines.splice(1, 0, "{not-json");
  await writeFile(eventsPath, lines.join("\n") + "\n", "utf-8");

  const harness2 = makeRecoveryHarness({ storeRoot: harness.storeRoot });
  const report = await harness2.service.restoreAll();
  assertEqual(report.corrupted, 1, "mid-log corruption counts as corrupted");
  assertEqual(report.restored, 0, "no task forged from the mid-corrupt log");
  const snap = harness2.service.getAll();
  assertEqual(snap.tasks.length, 0, "corrupt task never enters the task list");
  assertEqual(snap.recoveryIssues.length, 1, "mid_log_corrupt issue surfaced");
  assertEqual(snap.recoveryIssues[0].code, "mid_log_corrupt", "mid_log_corrupt code");
  assertEqual(snap.recoveryIssues[0].readOnly, true, "mid-corrupt record is read-only");
});

await run("index is only rewritten when index fields change", async () => {
  const harness = makeRecoveryHarness();
  const handle = await harness.service.createTaskGroup(makeParams("single", [makeTask(0)]), makeContext(harness), "foreground");
  const taskId = handle.tasks[0].taskId;
  const ws = workspaceIdOf(PROJECT.physicalPath);
  const indexPath = join(harness.storeRoot, ws, "index.json");
  await waitFor(() => existsSync(indexPath), 20000, "index written at creation");
  const before = readFileSync(indexPath, "utf-8");

  // Activities/output only touch the log: the index stays byte-identical.
  const fake = FakeRuntime.instances[0];
  fake.emitActivity({
    sequence: 1,
    toolCallId: "call-1",
    toolName: "read",
    status: "completed",
    summary: "src/a.ts",
    startedAt: Date.now(),
    endedAt: Date.now() + 1,
  });
  fake.emitOutput("streamed");
  await waitFor(() => findTask(harness, taskId).activities.length === 1, 20000, "activity reached the service");
  await drain();
  assertEqual(readFileSync(indexPath, "utf-8"), before, "index untouched by activity/output events");

  // A checkpoint changes the leaf seq (an index field) -> the index rewrites.
  fake.emitCheckpoint({ sessionFileName: "sess.jsonl", sessionLeafId: "leaf-1", openToolCalls: [] });
  // The index's lastCheckpointSeq mirrors the stamped checkpoint seq (the log
  // position at write time); wait until the index reflects the checkpoint that
  // carries at least the running-state position.
  const cpPath = join(harness.storeRoot, ws, taskId, "checkpoint.json");
  await waitFor(() => {
    try {
      const cpSeq = JSON.parse(readFileSync(cpPath, "utf-8")).seq as number;
      return cpSeq >= 2 && readFileSync(indexPath, "utf-8").includes(`"lastCheckpointSeq": ${cpSeq}`);
    } catch {
      return false;
    }
  }, 20000, "index records the checkpoint seq after the checkpoint");
});

// ============================================================================
// Runtime-level persistence tests (real runtime + real store)
// ============================================================================

const unhandledRejections: unknown[] = [];
const onUnhandledRejection = (reason: unknown): void => {
  unhandledRejections.push(reason);
};
process.on("unhandledRejection", onUnhandledRejection);

function assertNoUnhandledRejections(): void {
  assertEqual(unhandledRejections.length, 0, "no unhandled rejections observed");
  unhandledRejections.length = 0;
}

function sha256OfFile(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

await run("runtime: foreground task writes an independent session JSONL with checkpoints per leaf", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "pix-recovery-project-"));
  writeFileSync(join(projectDir, "a.txt"), "alpha content\n", "utf-8");
  // NOTE: a text-only scripted message ends the run (stopReason stop without
  // tool calls), so the tool call must lead the script.
  const scripts: StreamScript[] = [
    { kind: "message", text: "", stopReason: "stop", toolCall: { name: "read", id: "read-1", args: { path: "a.txt" } } },
    { kind: "message", text: "final answer", stopReason: "stop" },
  ];

  provider.scripts.length = 0;
  provider.scripts.push(...scripts);
  provider.calls.length = 0;
  const spec = makeSpec(projectDir, { items: [makeReadyItem()] });
  const store = new AgentTaskStore({
    rootDir: mkdtempSync(join(tmpdir(), "pix-recovery-runtime-store-")),
    maxTaskBytes: 25 * 1024 * 1024,
    maxWorkspaceBytes: 500 * 1024 * 1024,
  });
  const sessionsDir = store.getTaskSessionDir(spec.workspaceId, spec.taskId);
  mkdirSync(sessionsDir, { recursive: true });
  const input = makeInputMock();
  const checkpoints: TaskCheckpoint[] = [];
  const runtime = new AgentTaskRuntime({ spec, input: input.router, taskSessionDir: sessionsDir });
  try {
    const result = await runtime.run(new AbortController().signal, (event) => {
      if (event.type === "checkpoint") {
        checkpoints.push(event.checkpoint);
      }
    });
    assertEqual(result.status, "completed", "scripted task completed");
  } finally {
    await runtime.dispose();
  }

  // The task transcript lives in <task>/sessions/*.jsonl (one file per item).
  const files = existsSync(sessionsDir) ? readdirSync(sessionsDir) : [];
  assertEqual(files.length, 1, "exactly one session JSONL for the single item");
  const transcript = readFileSync(join(sessionsDir, files[0]), "utf-8");
  const entries = transcript.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
  assertEqual(entries[0].type, "session", "transcript starts with a session header");
  assert(entries.some((entry) => entry.type === "message" && entry.message.role === "assistant"), "assistant messages persisted");
  assert(entries.some((entry) => entry.type === "message" && entry.message.role === "toolResult"), "tool result leaf persisted");
  const entryIds = entries.filter((entry) => entry.type !== "session").map((entry) => entry.id);

  // Every finalized message / complete tool result / item boundary has a
  // checkpoint; each one points at a valid leaf of the transcript.
  assert(checkpoints.length >= 5, `checkpoints cover item/message/tool-result boundaries (got ${checkpoints.length})`);
  const sessionFileName = basename(files[0]);
  const leafIds = checkpoints.map((cp) => cp.sessionLeafId).filter((leaf): leaf is string => leaf !== null);
  assert(leafIds.every((leaf) => entryIds.includes(leaf)), "every checkpoint leaf is a real transcript entry");
  for (const cp of checkpoints) {
    assertEqual(cp.taskId, spec.taskId, "checkpoint carries the task id");
    assertEqual(cp.generation, 0, "checkpoint generation is the task generation");
    if (cp.sessionFileName !== null) {
      assertEqual(cp.sessionFileName, sessionFileName, "checkpoint points at the item's JSONL basename");
    }
  }
  const finalCp = checkpoints[checkpoints.length - 1];
  assertEqual(finalCp.sessionFileName, null, "item-end checkpoint clears the session file");
  assertEqual(finalCp.activeItemIndex, 1, "item-end checkpoint advances activeItemIndex");
  assertEqual(finalCp.openToolCalls.length, 0, "no open tool calls at item end");
  assertEqual(finalCp.lastFinalizedEntryId, leafIds[leafIds.length - 1], "lastFinalizedEntryId points at the final leaf");
  assert(finalCp.workspaceFingerprint.observedFileHashes["a.txt"] !== undefined, "observed read path hashed into the fingerprint");

  // The store usage counts the transcript + checkpoint + log bytes.
  const usage = await store.getWorkspaceUsage(spec.workspaceId);
  assert(usage.usedBytes > 0, "workspace usage counts persisted bytes");
  assert(usage.usedBytes >= readFileSync(join(sessionsDir, files[0]), "utf-8").length, "session transcript counts into usedBytes");

  assertNoUnhandledRejections();
  rmSync(projectDir, { recursive: true, force: true });
});

await run("runtime: workspace fingerprint is incremental; WSL batches one bash call per refresh", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "pix-recovery-wsl-project-"));
  writeFileSync(join(projectDir, "a.txt"), "alpha content\n", "utf-8");
  writeFileSync(join(projectDir, "b.txt"), "beta content\n", "utf-8");

  const bashCommands: string[] = [];
  const fakeBackend: ExecutionBackend = {
    paths: {
      pathStyle: "posix",
      homeDir: "/home/u",
      resolvePath: (input: string, cwd: string) => (input.startsWith("/") ? input : pathPosix.join(cwd, input)),
    },
    read: {
      readFile: async (absolutePath: string) => {
        const name = absolutePath.split("/").pop() ?? absolutePath;
        return readFileSync(join(projectDir, name));
      },
      access: async () => {},
    },
    bash: {
      exec: async (command: string, _cwd: string, opts: { onData: (data: Buffer) => void }) => {
        bashCommands.push(command);
        // Respond with sha256sum-style lines for the quoted paths in the
        // command, then an empty git section (non-git workspace).
        const paths = [...command.matchAll(/'([^']+)'/g)].map((match) => match[1]);
        let output = "";
        for (const abs of paths) {
          const name = abs.split("/").pop() ?? abs;
          const hostPath = join(projectDir, name);
          output += existsSync(hostPath) ? `${sha256OfFile(hostPath)}  ${abs}\n` : `PIX_MISS ${abs}\n`;
        }
        output += "\nPIX_GIT\n";
        opts.onData(Buffer.from(output, "utf-8"));
        return { exitCode: 0 };
      },
    },
    runtimeEnvironment: { platform: "linux", osName: "WSL2 (Ubuntu-22.04)", shell: { kind: "wsl", path: "wsl.exe" } },
    getCwd: () => "/home/u/repo",
    dispose: async () => {},
  };

  const scripts: StreamScript[] = [
    { kind: "message", text: "", stopReason: "stop", toolCall: { name: "read", id: "read-a", args: { path: "a.txt" } } },
    { kind: "message", text: "", stopReason: "stop", toolCall: { name: "read", id: "read-b", args: { path: "b.txt" } } },
    { kind: "message", text: "final", stopReason: "stop" },
  ];

  provider.scripts.length = 0;
  provider.scripts.push(...scripts);
  provider.calls.length = 0;
  const spec = makeSpec(projectDir, {
    items: [makeReadyItem()],
    project: {
      path: "/home/u/repo",
      physicalPath: projectDir,
      name: "recovery-wsl",
      environment: { kind: "wsl", distro: "Ubuntu-22.04" },
    },
  });
  const store = new AgentTaskStore({
    rootDir: mkdtempSync(join(tmpdir(), "pix-recovery-wsl-store-")),
    maxTaskBytes: 25 * 1024 * 1024,
    maxWorkspaceBytes: 500 * 1024 * 1024,
  });
  const sessionsDir = store.getTaskSessionDir(spec.workspaceId, spec.taskId);
  mkdirSync(sessionsDir, { recursive: true });
  const input = makeInputMock();
  const checkpoints: TaskCheckpoint[] = [];
  const runtime = new AgentTaskRuntime({ spec, input: input.router, taskSessionDir: sessionsDir });
  const restore = __setAgentTaskRuntimeContextFactoriesForTests(
    async () => ({
      location: spec.project,
      logicalCwd: "/home/u/repo",
      physicalCwd: projectDir,
      executionBackend: fakeBackend,
      isWsl: true,
    }),
    async () => {},
  );
  try {
    const result = await runtime.run(new AbortController().signal, (event) => {
      if (event.type === "checkpoint") {
        checkpoints.push(event.checkpoint);
      }
    });
    assertEqual(result.status, "completed", "scripted WSL task completed");
  } finally {
    restore();
    await runtime.dispose();
  }

  // One bash call per fingerprint refresh that observed NEW paths; text-only
  // messages and re-observed paths never trigger extra calls, and multiple
  // new paths share ONE call (no per-path wsl.exe roundtrips).
  assertEqual(bashCommands.length, 2, "exactly two bash fingerprint refreshes (a.txt round, b.txt round)");
  assert(bashCommands[0].includes("a.txt"), "first refresh hashes a.txt");
  assert(!bashCommands[0].includes("b.txt"), "first refresh does not hash b.txt");
  assert(bashCommands[1].includes("b.txt"), "second refresh hashes b.txt");
  assert(!bashCommands[1].includes("a.txt"), "unchanged observed path a.txt is NOT re-hashed");

  // The final checkpoint fingerprint carries BOTH paths (cached a.txt reused).
  const finalCp = checkpoints[checkpoints.length - 1];
  assertEqual(finalCp.workspaceFingerprint.isGit, false, "non-git workspace fingerprint");
  assertEqual(
    finalCp.workspaceFingerprint.observedFileHashes["a.txt"],
    sha256OfFile(join(projectDir, "a.txt")),
    "a.txt hash present and correct",
  );
  assertEqual(
    finalCp.workspaceFingerprint.observedFileHashes["b.txt"],
    sha256OfFile(join(projectDir, "b.txt")),
    "b.txt hash present and correct",
  );
  // Every emitted checkpoint is frozen at its capture time: the checkpoint
  // that first observed a.txt never gains b.txt from a later refresh.
  const firstWithA = checkpoints.find((cp) => cp.workspaceFingerprint.observedFileHashes["a.txt"] !== undefined)!;
  assert(firstWithA !== undefined, "a checkpoint observed a.txt");
  assertEqual(
    firstWithA.workspaceFingerprint.observedFileHashes["b.txt"],
    undefined,
    "a later observed path never leaks into an earlier emitted checkpoint",
  );
  assertEqual(
    Object.keys(firstWithA.workspaceFingerprint.observedFileHashes).join(","),
    "a.txt",
    "the earlier checkpoint fingerprint is frozen at capture time",
  );
  // The transcript still exists in its own sessions dir.
  const files = readdirSync(sessionsDir);
  assertEqual(files.length, 1, "WSL task wrote its own session JSONL");

  assertNoUnhandledRejections();
  rmSync(projectDir, { recursive: true, force: true });
});

await run("runtime: missing observed files hash to the fixed sentinel; host git absence yields isGit=false", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "pix-recovery-host-project-"));
  writeFileSync(join(projectDir, "a.txt"), "alpha content\n", "utf-8");
  const scripts: StreamScript[] = [
    { kind: "message", text: "", stopReason: "stop", toolCall: { name: "read", id: "read-missing", args: { path: "gone.txt" } } },
    { kind: "message", text: "done", stopReason: "stop" },
  ];
  provider.scripts.length = 0;
  provider.scripts.push(...scripts);
  provider.calls.length = 0;
  const spec = makeSpec(projectDir, { items: [makeReadyItem()] });
  const store = new AgentTaskStore({
    rootDir: mkdtempSync(join(tmpdir(), "pix-recovery-host-store-")),
    maxTaskBytes: 25 * 1024 * 1024,
    maxWorkspaceBytes: 500 * 1024 * 1024,
  });
  const sessionsDir = store.getTaskSessionDir(spec.workspaceId, spec.taskId);
  mkdirSync(sessionsDir, { recursive: true });
  const input = makeInputMock();
  const checkpoints: TaskCheckpoint[] = [];
  const runtime = new AgentTaskRuntime({ spec, input: input.router, taskSessionDir: sessionsDir });
  try {
    const result = await runtime.run(new AbortController().signal, (event) => {
      if (event.type === "checkpoint") {
        checkpoints.push(event.checkpoint);
      }
    });
    assertEqual(result.status, "completed", "task completed with a failing read");
  } finally {
    await runtime.dispose();
  }
  const finalCp = checkpoints[checkpoints.length - 1];
  assertEqual(finalCp.workspaceFingerprint.observedFileHashes["gone.txt"], "PIX-MISSING", "missing file hashes to the sentinel");
  assertEqual(finalCp.workspaceFingerprint.isGit, false, "non-git host workspace (no git binary/header)");
  assertEqual(finalCp.workspaceFingerprint.observedFileHashes["a.txt"], undefined, "unobserved files are not hashed");
  assertNoUnhandledRejections();
  rmSync(projectDir, { recursive: true, force: true });
});

// ============================================================================
// 1.4.2 (R3) resume helpers
// ============================================================================

function makeInfo(spec: AgentTaskSpec, overrides: Partial<AgentTaskInfo> = {}): AgentTaskInfo {
  const now = Date.now();
  const status = overrides.status ?? "running";
  const startedAt = status === "running" || status === "waiting_input" ? now : undefined;
  return {
    schemaVersion: 1,
    taskId: spec.taskId,
    groupId: spec.groupId,
    groupMode: spec.groupMode,
    workspaceId: spec.workspaceId,
    parentSessionId: spec.parentSessionId,
    parentToolCallId: spec.parentToolCallId,
    itemSummaries: spec.items.map((item) =>
      item.resolution === "ready"
        ? {
            index: item.index,
            agentName: item.agent.name,
            agentSource: item.agent.source,
            model: { provider: item.model.provider, modelId: item.model.modelId },
            maxTurns: item.maxTurns,
          }
        : { index: item.index, agentName: item.requestedAgentName ?? "general-purpose", agentSource: "unknown" },
    ),
    thinkingLevel: spec.thinkingLevel,
    executionMode: spec.executionMode,
    project: structuredClone(spec.project),
    presentation: "background",
    status: "running",
    description: spec.items[0]?.description ?? "",
    finalOutput: "",
    outputTruncated: false,
    originalOutputBytes: 0,
    results: [],
    activities: [],
    usage: emptyUsage(),
    toolUseCount: 0,
    createdAt: now,
    updatedAt: now,
    durationMs: 0,
    startedAt,
    planLink: spec.planLink ? structuredClone(spec.planLink) : undefined,
    deliveredSessionIds: [],
    planLinkState: spec.planLink ? "pending" : "none",
    generation: 0,
    ...overrides,
  };
}

function makeDefaultCheckpoint(spec: AgentTaskSpec, overrides: Partial<TaskCheckpoint> = {}): TaskCheckpoint {
  return {
    taskId: spec.taskId,
    generation: 0,
    seq: 0,
    activeItemIndex: 0,
    sessionFileName: null,
    sessionLeafId: null,
    openToolCalls: [],
    workspaceFingerprint: { isGit: false, observedFileHashes: {} },
    ts: Date.now(),
    ...overrides,
  };
}

/** Persist a full task record (metadata + state event + optional events + checkpoint + index). */
async function writeTaskRecord(
  store: AgentTaskStore,
  spec: AgentTaskSpec,
  opts: {
    status?: AgentTaskInfo["status"];
    generation?: number;
    events?: Array<{ type: "item_result"; result: SubagentSingleResult } | { type: "input_requested"; request: { taskId: string; requestId: string; generation: number; request: { id: string; questions: unknown[] } } }>;
    checkpoint?: TaskCheckpoint;
  } = {},
): Promise<void> {
  const ws = spec.workspaceId;
  await store.initWorkspace(ws);
  const info = makeInfo(spec, { status: opts.status ?? "running", generation: opts.generation ?? 0 });
  await store.writeMetadata(ws, spec.taskId, { schemaVersion: 1, spec, initialInfo: info });
  await store.appendEvent(ws, spec.taskId, { type: "state", from: "queued", to: info.status, info: { ...info } });
  for (const event of opts.events ?? []) {
    await store.appendEvent(ws, spec.taskId, event);
  }
  const cp = opts.checkpoint ?? makeDefaultCheckpoint(spec, { generation: opts.generation ?? 0 });
  await store.writeCheckpoint(ws, spec.taskId, cp);
  await store.writeIndex(ws, {
    schemaVersion: 1,
    workspaceId: ws,
    generation: 1,
    lastWriterRunId: "test-run",
    tasks: [
      {
        taskId: spec.taskId,
        workspaceId: ws,
        parentSessionId: spec.parentSessionId,
        parentToolCallId: spec.parentToolCallId,
        groupId: spec.groupId,
        status: info.status,
        lastCheckpointSeq: cp.seq,
        hasUnclosedToolCall: cp.openToolCalls.length > 0,
        updatedAt: Date.now(),
        schemaVersion: 1,
        lastWriterRunId: "test-run",
      },
    ],
  });
}

/** Hand-craft a persisted session transcript with optional open/closed/aborted tool calls. */
function craftSession(
  physicalCwd: string,
  taskSessionDir: string,
  opts: {
    userText?: string;
    openCalls?: Array<{ id: string; name: string }>;
    closedCalls?: Array<{ id: string; name: string; aborted?: boolean }>;
    emptyAbortedAssistant?: boolean;
  } = {},
): { fileName: string; leafId: string; manager: SessionManager } {
  mkdirSync(taskSessionDir, { recursive: true });
  const model = makeModel("faux-model");
  const manager = SessionManager.create(physicalCwd, taskSessionDir);
  manager.appendMessage({ role: "user", content: opts.userText ?? "original task prompt", timestamp: Date.now() } as never);
  for (const call of opts.openCalls ?? []) {
    manager.appendMessage(makeAssistantMessage(model, { text: "", toolCall: { name: call.name, id: call.id, args: {} } }));
  }
  for (const call of opts.closedCalls ?? []) {
    manager.appendMessage(makeAssistantMessage(model, { text: "", toolCall: { name: call.name, id: call.id, args: {} } }));
    manager.appendMessage({
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: "text", text: call.aborted === true ? "Operation aborted" : "ok" }],
      isError: call.aborted === true,
      timestamp: Date.now(),
    } as never);
  }
  if (opts.emptyAbortedAssistant === true) {
    manager.appendMessage(makeAssistantMessage(model, { stopReason: "aborted" }));
  }
  const fileName = basename(manager.getSessionFile()!);
  return { fileName, leafId: manager.getLeafId()!, manager };
}

function readTranscript(sessionsDir: string, fileName: string): Array<Record<string, unknown>> {
  const text = readFileSync(join(sessionsDir, fileName), "utf-8");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function makeFakeResumerFactory(): { factory: (spec: AgentTaskSpec) => unknown; } {
  return {
    factory: (spec: AgentTaskSpec) => {
      const fake = new FakeRuntime(spec);
      return fake as unknown as AgentTaskRuntime;
    },
  };
}

// ============================================================================
// 1.4.2 (R3) resume tests (resumer + runtime + service)
// ============================================================================

await run("resumer: truly open calls get exactly one interrupted_unknown; closed/aborted calls untouched; repeated prepare idempotent", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "pix-resumer-closure-"));
  const spec = makeSpec(projectDir, { items: [makeReadyItem()] });
  const store = new AgentTaskStore({
    rootDir: mkdtempSync(join(tmpdir(), "pix-resumer-closure-store-")),
    maxTaskBytes: 25 * 1024 * 1024,
    maxWorkspaceBytes: 500 * 1024 * 1024,
  });
  const sessionsDir = store.getTaskSessionDir(spec.workspaceId, spec.taskId);
  const crafted = craftSession(projectDir, sessionsDir, {
    openCalls: [{ id: "call-open", name: "read" }],
    closedCalls: [{ id: "call-closed", name: "edit" }, { id: "call-aborted", name: "write", aborted: true }],
    emptyAbortedAssistant: true,
  });
  const cp = makeDefaultCheckpoint(spec, {
    sessionFileName: crafted.fileName,
    sessionLeafId: crafted.leafId,
    openToolCalls: [
      { toolCallId: "call-open", toolName: "read", startedAt: Date.now() },
      { toolCallId: "call-closed", toolName: "edit", startedAt: Date.now() },
    ],
  });
  const info = makeInfo(spec, { status: "interrupted" });
  await writeTaskRecord(store, spec, { status: "interrupted", checkpoint: cp });
  const fakeFactory = makeFakeResumerFactory();
  const resumer = new AgentTaskResumer({
    store,
    runtimeFactory: (s, _dir) => fakeFactory.factory(s) as never,
  });
  const decision: ResumeDecision = { action: "continue", confirmWorkspaceChanges: true };

  const outcome = await resumer.prepare(info, cp, decision);
  assertEqual(outcome.ok, true, "prepare succeeds");
  if (!outcome.ok) return;
  const prepared = outcome.prepared;
  assertEqual(prepared.generation, 1, "prepared generation is task generation + 1");
  assertEqual(prepared.activeItemIndex, 0, "prepared activeItemIndex");
  assertEqual(prepared.effectiveModel.modelId, "faux-model", "continue inherits the frozen spec model");

  const entries = readTranscript(sessionsDir, crafted.fileName);
  const toolResults = entries.filter((e) => e.type === "message" && (e.message as { role?: string })?.role === "toolResult");
  const closedForOpen = toolResults.filter((r) => (r.message as { toolCallId?: string })?.toolCallId === "call-open");
  assertEqual(closedForOpen.length, 1, "exactly one ToolResult for the truly open call");
  assertEqual((closedForOpen[0].message as { isError?: boolean })?.isError, true, "closure ToolResult is an error");
  assert(
    ((closedForOpen[0].message as { content?: Array<{ text?: string }> })?.content ?? []).some((b) => (b.text ?? "").includes("interrupted_unknown")),
    "closure ToolResult carries the interrupted_unknown marker",
  );
  const closedForClosed = toolResults.filter((r) => (r.message as { toolCallId?: string })?.toolCallId === "call-closed");
  const closedForAborted = toolResults.filter((r) => (r.message as { toolCallId?: string })?.toolCallId === "call-aborted");
  assertEqual(closedForClosed.length, 1, "the normal closed call keeps its original ToolResult");
  assertEqual(closedForAborted.length, 1, "the 'Operation aborted' closed call keeps its original ToolResult");
  const notes = entries.filter((e) => e.type === "custom_message" && e.customType === RESUME_NOTE_CUSTOM_TYPE);
  assertEqual(notes.length, 1, "exactly one visible recovery note");
  assertEqual(notes[0].display, true, "the recovery note is visible");

  // Repeated prepare is idempotent: no new closure entries, no new note, and
  // the checkpoint was persisted with the OLD generation (before the service bump).
  const outcome2 = await resumer.prepare(info, cp, decision);
  assertEqual(outcome2.ok, true, "repeated prepare succeeds");
  const entries2 = readTranscript(sessionsDir, crafted.fileName);
  assertEqual(
    entries2.filter((e) => e.type === "message" && (e.message as { role?: string })?.role === "toolResult" && (e.message as { toolCallId?: string })?.toolCallId === "call-open").length,
    1,
    "repeated prepare appends no second closure",
  );
  assertEqual(
    entries2.filter((e) => e.type === "custom_message" && e.customType === RESUME_NOTE_CUSTOM_TYPE).length,
    1,
    "repeated prepare appends no second note",
  );
  const read = await store.readTask(spec.workspaceId, spec.taskId);
  assertEqual(read.checkpoint?.generation, 0, "persisted checkpoint carries the OLD generation");
  assertEqual(read.checkpoint?.sessionFileName, crafted.fileName, "persisted checkpoint references the transcript");
  assertEqual((prepared.checkpoint as TaskCheckpoint).lastFinalizedEntryId, crafted.leafId, "lastFinalizedEntryId points at the crafted assistant leaf");

  // A SECOND crash (task generation now 1) appends a NEW generation-tagged
  // note while the old note stays in the transcript (the model sees both).
  const infoGen1 = makeInfo(spec, { status: "interrupted", generation: 1 });
  const outcome3 = await resumer.prepare(infoGen1, cp, decision);
  assertEqual(outcome3.ok, true, "second-crash prepare succeeds");
  const entries3 = readTranscript(sessionsDir, crafted.fileName);
  const notes3 = entries3.filter((e) => e.type === "custom_message" && e.customType === RESUME_NOTE_CUSTOM_TYPE);
  assertEqual(notes3.length, 2, "second crash appends one more generation-tagged note");
  assertEqual((notes3[0].details as { generation?: number }).generation, 0, "first note tagged with generation 0");
  assertEqual((notes3[1].details as { generation?: number }).generation, 1, "second note tagged with generation 1");

  // The fake runtime saw the full seed.
  const fake = FakeRuntime.instances.find((candidate) => candidate.spec.taskId === spec.taskId)!;
  const seed = fake.resumeSeeds[0] as { checkpoint: TaskCheckpoint; decision: ResumeDecision; injectNote: string; priorResults: unknown[] };
  assertEqual(seed.checkpoint.sessionFileName, crafted.fileName, "seed checkpoint points at the repaired transcript");
  assertEqual(seed.priorResults.length, 0, "no prior results for a single fresh item");
  assert(seed.injectNote.includes("Recovery note"), "seed carries the recovery note");

  assertNoUnhandledRejections();
  rmSync(projectDir, { recursive: true, force: true });
});

await run("resumer: tail-corrupt session repaired with hash backup then append-legal; mid-log and header corruption isolated read-only", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "pix-resumer-scan-"));
  const spec = makeSpec(projectDir, { items: [makeReadyItem()] });
  const store = new AgentTaskStore({
    rootDir: mkdtempSync(join(tmpdir(), "pix-resumer-scan-store-")),
    maxTaskBytes: 25 * 1024 * 1024,
    maxWorkspaceBytes: 500 * 1024 * 1024,
  });
  const sessionsDir = store.getTaskSessionDir(spec.workspaceId, spec.taskId);
  const crafted = craftSession(projectDir, sessionsDir, { openCalls: [{ id: "call-1", name: "read" }] });
  const sessionPath = join(sessionsDir, crafted.fileName);
  const info = makeInfo(spec, { status: "interrupted" });
  const tailCp = makeDefaultCheckpoint(spec, { sessionFileName: crafted.fileName, sessionLeafId: crafted.leafId });
  await writeTaskRecord(store, spec, { status: "interrupted", checkpoint: tailCp });
  const fakeFactory = makeFakeResumerFactory();
  const resumer = new AgentTaskResumer({ store, runtimeFactory: (s) => fakeFactory.factory(s) as never });

  // Tail corruption: truncated final line (crash signature).
  await writeFile(sessionPath, readFileSync(sessionPath, "utf-8") + '{"type":"message","id":"partial"', "utf-8");
  const tailOutcome = await resumer.prepare(info, tailCp, { action: "continue", confirmWorkspaceChanges: true });
  assertEqual(tailOutcome.ok, true, "tail-corrupt prepare succeeds after repair");
  const files = readdirSync(sessionsDir);
  assert(files.some((f) => f.includes(".corrupt-") && f.endsWith(".bak")), "full hash-named backup preserved");
  const lines = readFileSync(sessionPath, "utf-8").split("\n").filter((line) => line.trim() !== "");
  assert(
    lines.every((line) => {
      try {
        JSON.parse(line);
        return true;
      } catch {
        return false;
      }
    }),
    "repaired working file is fully valid JSONL",
  );
  assert(
    readTranscript(sessionsDir, crafted.fileName).some(
      (e) => e.type === "message" && (e.message as { toolCallId?: string })?.toolCallId === "call-1" && (e.message as { isError?: boolean })?.isError === true,
    ),
    "closure entry appended after the atomic repair",
  );

  // Mid-log corruption: a bad line in the middle isolates the session read-only.
  const midPath = join(sessionsDir, crafted.fileName);
  const before = readFileSync(midPath, "utf-8");
  const midLines = before.split("\n").filter((line) => line.trim() !== "");
  midLines.splice(2, 0, "{not-json");
  await writeFile(midPath, midLines.join("\n") + "\n", "utf-8");
  const midOutcome = await resumer.prepare(info, tailCp, { action: "continue", confirmWorkspaceChanges: true });
  assertEqual(midOutcome.ok, false, "mid-log corruption rejects the prepare");
  if (!midOutcome.ok) {
    assertEqual(midOutcome.reason, "mid_log_corrupt", "mid_log_corrupt reason");
  }
  assertEqual(readFileSync(midPath, "utf-8"), midLines.join("\n") + "\n", "mid-corrupt file untouched (read-only isolation)");

  // Header corruption: an invalid first line rejects with session_header_corrupt.
  const headerPath = join(sessionsDir, crafted.fileName);
  const headerLines = readFileSync(headerPath, "utf-8").split("\n").filter((line) => line.trim() !== "");
  headerLines[0] = "{not-json";
  await writeFile(headerPath, headerLines.join("\n") + "\n", "utf-8");
  const headerOutcome = await resumer.prepare(info, tailCp, { action: "continue", confirmWorkspaceChanges: true });
  assertEqual(headerOutcome.ok, false, "header corruption rejects the prepare");
  if (!headerOutcome.ok) {
    assertEqual(headerOutcome.reason, "session_header_corrupt", "session_header_corrupt reason");
  }

  assertNoUnhandledRejections();
  rmSync(projectDir, { recursive: true, force: true });
});

await run("resumer: workspace fingerprint changes need confirmation; unavailable workspace refuses; switch_model validates the choice", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "pix-resumer-fp-"));
  writeFileSync(join(projectDir, "a.txt"), "alpha content\n", "utf-8");
  const spec = makeSpec(projectDir, { items: [makeReadyItem()] });
  const store = new AgentTaskStore({
    rootDir: mkdtempSync(join(tmpdir(), "pix-resumer-fp-store-")),
    maxTaskBytes: 25 * 1024 * 1024,
    maxWorkspaceBytes: 500 * 1024 * 1024,
  });
  const sessionsDir = store.getTaskSessionDir(spec.workspaceId, spec.taskId);
  const crafted = craftSession(projectDir, sessionsDir, { openCalls: [{ id: "call-1", name: "read" }] });
  const hash = createHash("sha256").update("alpha content\n").digest("hex");
  const cp = makeDefaultCheckpoint(spec, {
    sessionFileName: crafted.fileName,
    sessionLeafId: crafted.leafId,
    workspaceFingerprint: { isGit: false, observedFileHashes: { "a.txt": hash } },
  });
  const info = makeInfo(spec, { status: "interrupted" });
  await writeTaskRecord(store, spec, { status: "interrupted", checkpoint: cp });
  const fakeFactory = makeFakeResumerFactory();
  const resumer = new AgentTaskResumer({ store, runtimeFactory: (s) => fakeFactory.factory(s) as never });

  writeFileSync(join(projectDir, "a.txt"), "changed content\n", "utf-8");
  const unconfirmed = await resumer.prepare(info, cp, { action: "continue", confirmWorkspaceChanges: false });
  assertEqual(unconfirmed.ok, false, "unconfirmed workspace change rejected");
  if (!unconfirmed.ok) {
    assertEqual(unconfirmed.reason, "workspace_changed", "workspace_changed reason");
  }
  const confirmed = await resumer.prepare(info, cp, { action: "continue", confirmWorkspaceChanges: true });
  assertEqual(confirmed.ok, true, "confirmed workspace change proceeds");

  // Unavailable workspace (missing root) refuses regardless of confirmation.
  const missingInfo = makeInfo(spec, { status: "interrupted", project: makeLocation(join(projectDir, "gone")) });
  const missing = await resumer.prepare(missingInfo, cp, { action: "continue", confirmWorkspaceChanges: true });
  assertEqual(missing.ok, false, "unavailable workspace refuses resume");
  if (!missing.ok) {
    assertEqual(missing.reason, "workspace_unavailable", "workspace_unavailable reason");
  }

  // switch_model validates the choice against the task's own registry.
  const bogus = await resumer.prepare(info, cp, { action: "switch_model", provider: "faux", modelId: "nope-model", confirmWorkspaceChanges: true });
  assertEqual(bogus.ok, false, "unresolvable switch_model rejected");
  if (!bogus.ok) {
    assertEqual(bogus.reason, "model_not_found", "model_not_found reason");
  }
  const switched = await resumer.prepare(info, cp, { action: "switch_model", provider: "faux", modelId: "faux-model-2", confirmWorkspaceChanges: true });
  assertEqual(switched.ok, true, "resolvable switch_model succeeds");
  if (switched.ok) {
    assertEqual(switched.prepared.effectiveModel.modelId, "faux-model-2", "switch_model effective model");
    // Each prepare creates its own runtime; the LAST fake of this task is the
    // switch_model one.
    const fakes = FakeRuntime.instances.filter((candidate) => candidate.spec.taskId === spec.taskId);
    const seed = fakes[fakes.length - 1].resumeSeeds[0] as { effectiveModel: { provider: string; modelId: string } };
    assertEqual(seed.effectiveModel.modelId, "faux-model-2", "seed effective model is the validated choice");
  }

  assertNoUnhandledRejections();
  rmSync(projectDir, { recursive: true, force: true });
});

await run("resumer: between-items checkpoint creates the next item's session; all-items-done rejects; unresolved inputs settle cancelled idempotently", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "pix-resumer-between-"));
  const spec = makeSpec(projectDir, {
    mode: "chain",
    items: [
      makeReadyItem(),
      { ...makeReadyItem(), index: 1, prompt: "second step", description: "second step" },
    ],
  });
  const store = new AgentTaskStore({
    rootDir: mkdtempSync(join(tmpdir(), "pix-resumer-between-store-")),
    maxTaskBytes: 25 * 1024 * 1024,
    maxWorkspaceBytes: 500 * 1024 * 1024,
  });
  const sessionsDir = store.getTaskSessionDir(spec.workspaceId, spec.taskId);
  const priorResult: SubagentSingleResult = {
    id: "prior-0",
    index: 0,
    agentName: "general-purpose",
    agentSource: "built-in",
    description: "first step",
    status: "completed",
    finalOutput: "first output",
    outputTruncated: false,
    originalOutputBytes: 0,
    toolUseCount: 0,
    activities: [],
    usage: emptyUsage(),
    startedAt: Date.now(),
    endedAt: Date.now(),
    durationMs: 1,
  };
  const cp = makeDefaultCheckpoint(spec, { activeItemIndex: 1 });
  const info = makeInfo(spec, { status: "interrupted", generation: 0 });
  await writeTaskRecord(store, spec, {
    status: "interrupted",
    events: [{ type: "item_result", result: priorResult }],
    checkpoint: cp,
  });
  const fakeFactory = makeFakeResumerFactory();
  const resumer = new AgentTaskResumer({ store, runtimeFactory: (s) => fakeFactory.factory(s) as never });

  // all-items-done refuses a new round and requires terminal convergence.
  const done = await resumer.prepare(info, makeDefaultCheckpoint(spec, { activeItemIndex: 2 }), { action: "continue", confirmWorkspaceChanges: true });
  assertEqual(done.ok, false, "all-items-done rejects the resume");
  if (!done.ok) {
    assertEqual(done.reason, "task_completed", "task_completed reason");
  }

  // Between items: the next item's session is created with the note.
  const outcome = await resumer.prepare(info, cp, { action: "continue", confirmWorkspaceChanges: true });
  assertEqual(outcome.ok, true, "between-items prepare succeeds");
  if (!outcome.ok) return;
  const files = readdirSync(sessionsDir);
  assertEqual(files.length, 1, "next item session file created");
  const entries = readTranscript(sessionsDir, files[0]);
  assertEqual(entries[0].type, "session", "created session starts with a valid header");
  const notes = entries.filter((e) => e.type === "custom_message" && e.customType === RESUME_NOTE_CUSTOM_TYPE);
  assertEqual(notes.length, 1, "recovery note in the created session");
  const fake = FakeRuntime.instances.find((candidate) => candidate.spec.taskId === spec.taskId)!;
  const seed = fake.resumeSeeds[0] as { checkpoint: TaskCheckpoint; priorResults: SubagentSingleResult[] };
  assertEqual(seed.checkpoint.sessionFileName, files[0], "seed checkpoint references the created session");
  assertEqual(seed.checkpoint.sessionLeafId, (notes[0] as { id: string }).id, "seed leaf is the note entry");
  assertEqual(seed.priorResults.length, 1, "prior results folded from the events");
  assertEqual(seed.priorResults[0].index, 0, "folded prior result keeps its item index");

  // Unanswered input requests settle as cancelled, idempotently (fresh task:
  // the events log must not already carry the between-items chain record).
  const inputSpec = makeSpec(projectDir, { items: [makeReadyItem()] });
  const inputCp = makeDefaultCheckpoint(inputSpec, { activeItemIndex: 0 });
  const inputInfo = makeInfo(inputSpec, { status: "interrupted" });
  await writeTaskRecord(store, inputSpec, {
    status: "interrupted",
    events: [
      {
        type: "input_requested",
        request: { taskId: inputSpec.taskId, requestId: "req-1", generation: 0, request: { id: "req-1", questions: [] } },
      },
    ],
    checkpoint: inputCp,
  });
  await resumer.prepare(inputInfo, inputCp, { action: "continue", confirmWorkspaceChanges: true });
  let read = await store.readTask(inputSpec.workspaceId, inputSpec.taskId);
  const settled = read.events.filter((e) => e.type === "input_settled");
  assertEqual(settled.length, 1, "one input_settled appended");
  if (settled.length === 1) {
    assertEqual((settled[0] as { outcome: string }).outcome, "cancelled", "unanswered input settles cancelled");
  }
  await resumer.prepare(inputInfo, inputCp, { action: "continue", confirmWorkspaceChanges: true });
  read = await store.readTask(inputSpec.workspaceId, inputSpec.taskId);
  assertEqual(read.events.filter((e) => e.type === "input_settled").length, 1, "repeated prepare does not double-settle");

  assertNoUnhandledRejections();
  rmSync(projectDir, { recursive: true, force: true });
});

await run("resumer: WSL fingerprint bash failure returns structured workspace_unavailable instead of leaking the raw error", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "pix-resumer-wsl-fp-"));
  writeFileSync(join(projectDir, "a.txt"), "alpha content\n", "utf-8");
  const spec = makeSpec(projectDir, {
    project: {
      path: "/home/u/repo",
      physicalPath: projectDir,
      name: "recovery-wsl",
      environment: { kind: "wsl", distro: "Ubuntu-22.04" },
    },
    items: [makeReadyItem()],
  });
  const store = new AgentTaskStore({
    rootDir: mkdtempSync(join(tmpdir(), "pix-resumer-wsl-fp-store-")),
    maxTaskBytes: 25 * 1024 * 1024,
    maxWorkspaceBytes: 500 * 1024 * 1024,
  });
  const sessionsDir = store.getTaskSessionDir(spec.workspaceId, spec.taskId);
  const crafted = craftSession(projectDir, sessionsDir, { openCalls: [{ id: "call-1", name: "read" }] });
  const hashCp = makeDefaultCheckpoint(spec, {
    sessionFileName: crafted.fileName,
    sessionLeafId: crafted.leafId,
    workspaceFingerprint: { isGit: false, observedFileHashes: { "a.txt": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } },
  });
  const gitCp = makeDefaultCheckpoint(spec, {
    sessionFileName: crafted.fileName,
    sessionLeafId: crafted.leafId,
    workspaceFingerprint: {
      isGit: true,
      head: "0123456789abcdef0123456789abcdef01234567",
      dirtySummary: "M a.txt",
      observedFileHashes: {},
    },
  });
  const info = makeInfo(spec, { status: "interrupted" });
  await writeTaskRecord(store, spec, { status: "interrupted", checkpoint: hashCp });
  const fakeFactory = makeFakeResumerFactory();
  const resumer = new AgentTaskResumer({ store, runtimeFactory: (s) => fakeFactory.factory(s) as never });

  // WSL context whose bash.exec always fails (distro hangs -> 30s timeout).
  const failingBackend: ExecutionBackend = {
    paths: {
      pathStyle: "posix",
      homeDir: "/home/u",
      resolvePath: (input: string, cwd: string) => (input.startsWith("/") ? input : pathPosix.join(cwd, input)),
    },
    read: { readFile: async () => Buffer.alloc(0), access: async () => {} },
    bash: {
      exec: async () => {
        throw new Error("timeout:30");
      },
    },
    runtimeEnvironment: { platform: "linux", osName: "WSL2 (Ubuntu-22.04)", shell: { kind: "wsl", path: "wsl.exe" } },
    getCwd: () => "/home/u/repo",
    dispose: async () => {},
  };
  const restore = __setAgentTaskResumerContextFactoriesForTests(
    async () => ({
      location: spec.project,
      logicalCwd: "/home/u/repo",
      physicalCwd: projectDir,
      executionBackend: failingBackend,
      isWsl: true,
    }),
    async () => {},
  );
  try {
    // Hash-read path: the observed-file bash call throws mid-comparison.
    let outcome: { ok: boolean; reason?: string } | undefined;
    let threw: unknown;
    try {
      outcome = await resumer.prepare(info, hashCp, { action: "continue", confirmWorkspaceChanges: true });
    } catch (error) {
      threw = error;
    }
    assertEqual(threw === undefined, true, "hash-read bash failure does not throw out of prepare");
    assertEqual(outcome?.ok, false, "hash-read bash failure returns a structured failure");
    assertEqual(outcome?.reason, "workspace_unavailable", "hash-read bash failure surfaces workspace_unavailable");
    // The failed comparison ran before any closure/note append: nothing modified.
    const entries = readTranscript(sessionsDir, crafted.fileName);
    assertEqual(
      entries.filter((e) => e.type === "custom_message" && e.customType === RESUME_NOTE_CUSTOM_TYPE).length,
      0,
      "failed fingerprint comparison appends no recovery note",
    );

    // Git-state path: the git bash call throws (isGit workspace).
    let gitOutcome: { ok: boolean; reason?: string } | undefined;
    let gitThrew: unknown;
    try {
      gitOutcome = await resumer.prepare(info, gitCp, { action: "continue", confirmWorkspaceChanges: true });
    } catch (error) {
      gitThrew = error;
    }
    assertEqual(gitThrew === undefined, true, "git-read bash failure does not throw out of prepare");
    assertEqual(gitOutcome?.ok, false, "git-read bash failure returns a structured failure");
    assertEqual(gitOutcome?.reason, "workspace_unavailable", "git-read bash failure surfaces workspace_unavailable");
  } finally {
    restore();
  }

  assertNoUnhandledRejections();
  rmSync(projectDir, { recursive: true, force: true });
});

await run("resumer: a failed between-items prepare never leaves the created next-item session file behind", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "pix-resumer-orphan-"));
  const spec = makeSpec(projectDir, {
    mode: "chain",
    items: [
      makeReadyItem(),
      { ...makeReadyItem(), index: 1, prompt: "second step", description: "second step" },
    ],
  });
  const store = new AgentTaskStore({
    rootDir: mkdtempSync(join(tmpdir(), "pix-resumer-orphan-store-")),
    maxTaskBytes: 25 * 1024 * 1024,
    maxWorkspaceBytes: 500 * 1024 * 1024,
  });
  const sessionsDir = store.getTaskSessionDir(spec.workspaceId, spec.taskId);
  const priorResult: SubagentSingleResult = {
    id: "prior-0",
    index: 0,
    agentName: "general-purpose",
    agentSource: "built-in",
    description: "first step",
    status: "completed",
    finalOutput: "first output",
    outputTruncated: false,
    originalOutputBytes: 0,
    toolUseCount: 0,
    activities: [],
    usage: emptyUsage(),
    startedAt: Date.now(),
    endedAt: Date.now(),
    durationMs: 1,
  };
  const cp = makeDefaultCheckpoint(spec, { activeItemIndex: 1 });
  const info = makeInfo(spec, { status: "interrupted", generation: 0 });
  await writeTaskRecord(store, spec, {
    status: "interrupted",
    events: [{ type: "item_result", result: priorResult }],
    checkpoint: cp,
  });
  const fakeFactory = makeFakeResumerFactory();
  const resumer = new AgentTaskResumer({ store, runtimeFactory: (s) => fakeFactory.factory(s) as never });

  // (a) switch_model rejection after the session file was created removes it.
  const rejected = await resumer.prepare(info, cp, { action: "switch_model", provider: "faux", modelId: "nope-model", confirmWorkspaceChanges: true });
  assertEqual(rejected.ok, false, "unresolvable switch_model rejects the between-items prepare");
  if (!rejected.ok) {
    assertEqual(rejected.reason, "model_not_found", "model_not_found reason");
  }
  assertEqual(readdirSync(sessionsDir).length, 0, "rejected prepare removes the created next-item session file");

  // (b) prepareResume failure after the session file was created removes it.
  const failingResumer = new AgentTaskResumer({
    store,
    runtimeFactory: (s) => {
      const fake = new FakeRuntime(s);
      fake.prepareResume = (seed) => {
        fake.prepareCalls++;
        fake.resumeSeeds.push(seed);
        return Promise.reject(new Error("session_start_failed"));
      };
      return fake as unknown as AgentTaskRuntime;
    },
  });
  const failed = await failingResumer.prepare(info, cp, { action: "continue", confirmWorkspaceChanges: true });
  assertEqual(failed.ok, false, "prepareResume failure rejects the between-items prepare");
  if (!failed.ok) {
    assertEqual(failed.reason, "session_start_failed", "session_start_failed reason");
  }
  assertEqual(readdirSync(sessionsDir).length, 0, "prepareResume failure removes the created next-item session file");

  assertNoUnhandledRejections();
  rmSync(projectDir, { recursive: true, force: true });
});

await run("runtime resume: prepareResume opens the repaired session; run prompts RESUME_TURN_MESSAGE exactly once and completes", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "pix-resumer-runtime-"));
  writeFileSync(join(projectDir, "a.txt"), "alpha content\n", "utf-8");
  const spec = makeSpec(projectDir, { items: [makeReadyItem()] });
  const store = new AgentTaskStore({
    rootDir: mkdtempSync(join(tmpdir(), "pix-resumer-runtime-store-")),
    maxTaskBytes: 25 * 1024 * 1024,
    maxWorkspaceBytes: 500 * 1024 * 1024,
  });
  const sessionsDir = store.getTaskSessionDir(spec.workspaceId, spec.taskId);
  const crafted = craftSession(projectDir, sessionsDir, { openCalls: [{ id: "call-open", name: "read" }] });
  const cp = makeDefaultCheckpoint(spec, { sessionFileName: crafted.fileName, sessionLeafId: crafted.leafId });
  const info = makeInfo(spec, { status: "interrupted" });
  await writeTaskRecord(store, spec, { status: "interrupted", checkpoint: cp });
  const input = makeInputMock();

  provider.scripts.length = 0;
  provider.scripts.push({ kind: "message", text: "resumed answer", stopReason: "stop" });
  provider.calls.length = 0;
  const resumer = new AgentTaskResumer({
    store,
    runtimeFactory: (s, dir) => new AgentTaskRuntime({ spec: s, input: input.router, taskSessionDir: dir }),
  });
  const outcome = await resumer.prepare(info, cp, { action: "continue", confirmWorkspaceChanges: true });
  assertEqual(outcome.ok, true, "real-runtime prepare succeeds");
  if (!outcome.ok) return;
  const prepared = outcome.prepared;

  const beforeRun = readTranscript(sessionsDir, prepared.checkpoint.sessionFileName!);
  assert(
    beforeRun.some(
      (e) =>
        e.type === "message" &&
        (e.message as { role?: string })?.role === "toolResult" &&
        (e.message as { toolCallId?: string })?.toolCallId === "call-open" &&
        (e.message as { isError?: boolean })?.isError === true,
    ),
    "interrupted_unknown ToolResult appended before prepareResume returned",
  );
  assertEqual(
    beforeRun.filter((e) => e.type === "custom_message" && e.customType === RESUME_NOTE_CUSTOM_TYPE).length,
    1,
    "recovery note appended once",
  );
  // prepareResume returned a checkpoint pointing at the repaired transcript leaf.
  assertEqual(prepared.checkpoint.sessionFileName, crafted.fileName, "prepared checkpoint references the repaired transcript");
  assertEqual(prepared.checkpoint.openToolCalls.length, 0, "no open calls in the prepared checkpoint");

  const result = await prepared.runtime.run(new AbortController().signal, () => {});
  await prepared.runtime.dispose();
  assertEqual(result.status, "completed", "resumed run completed");
  assertEqual(result.results.length, 1, "runtime result carries the resumed item result");

  const transcript = readTranscript(sessionsDir, prepared.checkpoint.sessionFileName!);
  const userTexts = transcript
    .filter((e) => e.type === "message" && (e.message as { role?: string })?.role === "user")
    .map((e) => {
      const content = (e.message as { content?: string | Array<{ text?: string }> }).content;
      return Array.isArray(content) ? content.map((b) => b.text ?? "").join("") : (content ?? "");
    });
  assertEqual(userTexts.length, 2, "two user messages total: original prompt + resume turn");
  assertEqual(userTexts.filter((text) => text.includes(RESUME_TURN_MESSAGE)).length, 1, "fixed RESUME_TURN_MESSAGE sent exactly once");
  assertEqual(
    transcript.filter((e) => e.type === "custom_message" && e.customType === RESUME_NOTE_CUSTOM_TYPE).length,
    1,
    "the recovery note is never re-injected by the run",
  );
  assertEqual(
    transcript.filter((e) => e.type === "message" && (e.message as { role?: string })?.role === "assistant").length,
    2,
    "two assistant messages: the crashed one + the resumed answer",
  );

  assertNoUnhandledRejections();
  rmSync(projectDir, { recursive: true, force: true });
});

await run("runtime resume: chain with a failed folded prefix converges without any model turn", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "pix-resumer-chain-"));
  const spec = makeSpec(projectDir, {
    mode: "chain",
    items: [
      makeReadyItem(),
      { ...makeReadyItem(), index: 1, prompt: "second step", description: "second step" },
    ],
  });
  const store = new AgentTaskStore({
    rootDir: mkdtempSync(join(tmpdir(), "pix-resumer-chain-store-")),
    maxTaskBytes: 25 * 1024 * 1024,
    maxWorkspaceBytes: 500 * 1024 * 1024,
  });
  const sessionsDir = store.getTaskSessionDir(spec.workspaceId, spec.taskId);
  // The session must contain an assistant message so SessionManager flushes the
  // file to disk; the empty aborted assistant doubles as the turn-termination
  // marker that must never be treated as an open call.
  const crafted = craftSession(projectDir, sessionsDir, { userText: "second step", emptyAbortedAssistant: true });
  const failedPrior: SubagentSingleResult = {
    id: "prior-failed",
    index: 0,
    agentName: "general-purpose",
    agentSource: "built-in",
    description: "first step",
    status: "failed",
    finalOutput: "",
    outputTruncated: false,
    originalOutputBytes: 0,
    toolUseCount: 0,
    activities: [],
    usage: emptyUsage(),
    failureReason: "api_error",
    errorMessage: "boom",
    endedAt: Date.now(),
    durationMs: 10,
  };
  const cp = makeDefaultCheckpoint(spec, { activeItemIndex: 1, sessionFileName: crafted.fileName, sessionLeafId: crafted.leafId });
  const info = makeInfo(spec, { status: "interrupted" });
  await writeTaskRecord(store, spec, {
    status: "interrupted",
    events: [{ type: "item_result", result: failedPrior }],
    checkpoint: cp,
  });
  const input = makeInputMock();
  provider.calls.length = 0;
  const resumer = new AgentTaskResumer({
    store,
    runtimeFactory: (s, dir) => new AgentTaskRuntime({ spec: s, input: input.router, taskSessionDir: dir }),
  });
  const outcome = await resumer.prepare(info, cp, { action: "continue", confirmWorkspaceChanges: true });
  assertEqual(outcome.ok, true, "chain resume prepare succeeds");
  if (!outcome.ok) return;
  const result = await outcome.prepared.runtime.run(new AbortController().signal, () => {});
  await outcome.prepared.runtime.dispose();
  assertEqual(result.status, "failed", "chain converges to the folded failure");
  assertEqual(result.results.length, 1, "only the folded prior result");
  assertEqual(result.results[0].index, 0, "folded prior result kept");
  assertEqual(provider.calls.length, 0, "no model turn was triggered (zero replay)");

  assertNoUnhandledRejections();
  rmSync(projectDir, { recursive: true, force: true });
});

await run("service resume: restore -> resume -> queued -> running; assistant_finalized records resume_succeeded; generation bumps; switch_model updates the itemSummary", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "pix-resume-service-"));
  const location = makeLocation(projectDir);
  const harness = makeRecoveryHarness();
  const handle = await harness.service.createTaskGroup(makeParams("single", [makeTask(0)]), makeContext(harness, { project: location }), "foreground");
  const taskId = handle.tasks[0].taskId;
  await harness.service.prepareShutdown();

  const harness2 = makeRecoveryHarness({ storeRoot: harness.storeRoot });
  await harness2.service.restoreAll();
  const restored = findTask(harness2, taskId);
  assertEqual(restored.status, "interrupted", "task restored interrupted");
  assertEqual(restored.generation, 0, "restored generation 0");

  const resumeResult = await harness2.service.resume(taskId, 0, { action: "continue", confirmWorkspaceChanges: true });
  assertEqual(resumeResult.ok, true, "resume succeeds");
  const afterResume = findTask(harness2, taskId);
  assertEqual(afterResume.generation, 1, "generation bumped to 1");
  assertEqual(afterResume.status, "running", "slot granted immediately (single running task)");
  assertEqual(afterResume.itemSummaries[0].model?.modelId, "parent-model", "continue keeps the persisted model");

  const resumedFake = FakeRuntime.instances.find((candidate) => candidate.spec.taskId === taskId && candidate.prepareCalls > 0);
  assert(resumedFake !== undefined, "resumed runtime received prepareResume");
  const seed = resumedFake!.resumeSeeds[0] as { checkpoint: TaskCheckpoint; effectiveModel: { provider: string; modelId: string }; priorResults: unknown[] };
  assertEqual(seed.checkpoint.sessionFileName !== null, true, "between-items resume created a session file");
  const sessionsDir = harness2.store.getTaskSessionDir(workspaceIdOf(projectDir), taskId);
  const sessionFiles = existsSync(sessionsDir) ? readdirSync(sessionsDir) : [];
  assertEqual(sessionFiles.length, 1, "exactly one next-item session file");
  const note = readTranscript(sessionsDir, sessionFiles[0]).filter((e) => e.type === "custom_message" && e.customType === RESUME_NOTE_CUSTOM_TYPE);
  assertEqual(note.length, 1, "recovery note written into the created session");
  assertEqual(seed.effectiveModel.modelId, "parent-model", "continue inherits the frozen spec model");
  assertEqual(seed.priorResults.length, 0, "no prior results for a fresh single task");

  // The persisted checkpoint carries the NEW generation after the service write.
  const read = await harness2.store.readTask(workspaceIdOf(projectDir), taskId);
  assertEqual(read.checkpoint?.generation, 1, "persisted checkpoint generation bumped to 1");
  assertEqual(afterResume.lastCheckpointSeq, read.checkpoint?.seq, "info lastCheckpointSeq mirrors the persisted checkpoint");

  // A new finalized assistant message is the resume success criterion.
  resumedFake!.emitAssistantFinalized();
  await drain();
  assert(harness2.events.records.some((e) => e.name === "agent_task_resume_succeeded"), "agent_task_resume_succeeded recorded");
  resumedFake!.complete();
  await waitFor(() => findTask(harness2, taskId).status === "completed", 20000, "resumed task completed");
  assert(harness2.events.records.some((e) => e.name === "agent_task_completed"), "terminal event recorded after the resumed run");

  // switch_model: a second interrupted task resumes with an explicit model.
  const handle2 = await harness2.service.createTaskGroup(makeParams("single", [makeTask(1)]), makeContext(harness2, { project: location }), "foreground");
  const taskId2 = handle2.tasks[0].taskId;
  await harness2.service.prepareShutdown();
  const harness3 = makeRecoveryHarness({ storeRoot: harness.storeRoot });
  await harness3.service.restoreAll();
  const switchResult = await harness3.service.resume(taskId2, 0, {
    action: "switch_model",
    provider: "faux",
    modelId: "faux-model-2",
    confirmWorkspaceChanges: true,
  });
  assertEqual(switchResult.ok, true, "switch_model resume succeeds");
  const switched = findTask(harness3, taskId2);
  assertEqual(switched.itemSummaries[0].model?.modelId, "faux-model-2", "switch_model updates the itemSummary model");
  assertEqual(switched.generation, 1, "switch_model resume bumps the generation");

  assertNoUnhandledRejections();
  rmSync(projectDir, { recursive: true, force: true });
});

await run("service resume failure paths: budget failure keeps interrupted and never touches the transcript; stale generation; concurrent resume rejected", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "pix-resume-fail-"));
  const location = makeLocation(projectDir);

  // Budget failure: the resume reservation cannot fit -> storage_limit, no
  // transcript modification, task stays interrupted. The 2MB reserve fits
  // creation (empty workspace) but not the resume (the workspace already holds
  // the task record, so used + 2MB exceeds the ~2MB+8KB limit).
  const LIMIT = 2 * 1024 * 1024 + 6 * 1024;
  const harness = makeRecoveryHarness({ maxTaskBytes: LIMIT, maxWorkspaceBytes: LIMIT, reserveBytesOverride: 2 * 1024 * 1024 });
  const handle = await harness.service.createTaskGroup(makeParams("single", [makeTask(0)]), makeContext(harness, { project: location }), "foreground");
  const taskId = handle.tasks[0].taskId;
  await harness.service.prepareShutdown();
  const harness2 = makeRecoveryHarness({ storeRoot: harness.storeRoot, maxTaskBytes: LIMIT, maxWorkspaceBytes: LIMIT, reserveBytesOverride: 2 * 1024 * 1024 });
  await harness2.service.restoreAll();
  const sessionsDir = harness2.store.getTaskSessionDir(workspaceIdOf(projectDir), taskId);
  const beforeFiles = existsSync(sessionsDir) ? readdirSync(sessionsDir) : [];
  const budgetResult = await harness2.service.resume(taskId, 0, { action: "continue", confirmWorkspaceChanges: true });
  assertEqual(budgetResult.ok, false, "budget failure rejects the resume");
  if (!budgetResult.ok) {
    assertEqual(budgetResult.reason, "storage_limit", "storage_limit reason");
  }
  assertEqual(findTask(harness2, taskId).status, "interrupted", "budget failure keeps the task interrupted");
  assertEqual((existsSync(sessionsDir) ? readdirSync(sessionsDir) : []).length, beforeFiles.length, "budget failure never touches the transcript");
  assert(harness2.events.records.some((e) => e.name === "agent_task_resume_failed"), "agent_task_resume_failed recorded");

  // Stale generation / wrong status are rejected before any side effect.
  const stale = await harness2.service.resume(taskId, 999, { action: "continue", confirmWorkspaceChanges: true });
  assertEqual(stale.ok, false, "stale generation rejected");
  if (!stale.ok) {
    assertEqual(stale.reason, "stale_generation", "stale_generation reason");
  }
  const markDone = await harness2.service.markFailed(taskId, 0, "user_decision");
  assertEqual(markDone.ok, true, "mark_failed on interrupted ok");
  const nonInterrupted = await harness2.service.resume(taskId, 0, { action: "continue", confirmWorkspaceChanges: true });
  assertEqual(nonInterrupted.ok, false, "non-interrupted resume rejected");
  if (!nonInterrupted.ok) {
    assertEqual(nonInterrupted.reason, "task_not_interrupted", "task_not_interrupted reason");
  }

  // Concurrent resume: the per-task mutex rejects the second request.
  const harness3 = makeRecoveryHarness({ storeRoot: harness.storeRoot });
  await harness3.service.restoreAll();
  const task2 = findTask(harness3, taskId);
  if (task2.status === "interrupted") {
    const first = harness3.service.resume(taskId, 0, { action: "continue", confirmWorkspaceChanges: true });
    const second = await harness3.service.resume(taskId, 0, { action: "continue", confirmWorkspaceChanges: true });
    assertEqual(second.ok, false, "concurrent resume rejected by the mutex");
    if (!second.ok) {
      assertEqual(second.reason, "resume_in_progress", "resume_in_progress reason");
    }
    await first;
  }

  assertNoUnhandledRejections();
  rmSync(projectDir, { recursive: true, force: true });
});

await run("service resume: a critical-section persist failure keeps interrupted, releases the reservation, and retries cleanly", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "pix-resume-cs-"));
  const location = makeLocation(projectDir);
  const harness = makeRecoveryHarness();
  const handle = await harness.service.createTaskGroup(makeParams("single", [makeTask(0)]), makeContext(harness, { project: location }), "foreground");
  const taskId = handle.tasks[0].taskId;
  await harness.service.prepareShutdown();

  const failingStore = new FailingAppendStore({
    rootDir: harness.storeRoot,
    maxTaskBytes: 25 * 1024 * 1024,
    maxWorkspaceBytes: 500 * 1024 * 1024,
  });
  const harness2 = makeRecoveryHarness({ storeRoot: harness.storeRoot, store: failingStore });
  await harness2.service.restoreAll();
  assertEqual(findTask(harness2, taskId).status, "interrupted", "task restored interrupted");
  assertEqual(findTask(harness2, taskId).generation, 0, "restored generation 0");

  // The next append is the critical section's generation+1 queued state event
  // (a fresh interrupted task has no unresolved inputs for prepare to settle).
  failingStore.nextAppendError = new TaskStorageLimitError("injected workspace storage budget exceeded");
  const result = await harness2.service.resume(taskId, 0, { action: "continue", confirmWorkspaceChanges: true });
  assertEqual(result.ok, false, "resume fails on the storage-limit flush");
  if (!result.ok) {
    assertEqual(result.reason, "storage_limit", "storage_limit reason");
  }
  await drain();
  const info = findTask(harness2, taskId);
  assertEqual(info.status, "interrupted", "task stays interrupted (never failed)");
  assertEqual(info.failureReason, undefined, "no failure reason on the compensated task");
  const reserved = (await harness2.store.getWorkspaceUsage(workspaceIdOf(projectDir))).reservedBytes;
  assertEqual(reserved, 0, "reservation released after the compensated failure");
  const preparedFake = FakeRuntime.instances.find((candidate) => candidate.spec.taskId === taskId && candidate.prepareCalls > 0);
  assert(preparedFake !== undefined, "the resumer prepared a runtime");
  assertEqual(preparedFake?.disposeCalls, 1, "the prepared runtime was disposed");
  assert(harness2.events.records.some((e) => e.name === "agent_task_resume_failed"), "agent_task_resume_failed recorded");
  assert(harness2.events.records.every((e) => e.name !== "agent_task_failed"), "the task was never reported failed");

  // The failed attempt kept the prepared generation; a retry at the new
  // generation goes through and reaches running.
  const retry = await harness2.service.resume(taskId, 1, { action: "continue", confirmWorkspaceChanges: true });
  assertEqual(retry.ok, true, "retry resume succeeds");
  await waitFor(() => findTask(harness2, taskId).status === "running", 20000, "retried resume reaches running");

  assertNoUnhandledRejections();
  rmSync(projectDir, { recursive: true, force: true });
});

await run("service resume: mid-log corruption during the critical section surfaces a read-only recovery issue and never fails the task", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "pix-resume-midcorrupt-"));
  const location = makeLocation(projectDir);
  const harness = makeRecoveryHarness();
  const handle = await harness.service.createTaskGroup(makeParams("single", [makeTask(0)]), makeContext(harness, { project: location }), "foreground");
  const taskId = handle.tasks[0].taskId;
  await harness.service.prepareShutdown();

  const harness2 = makeRecoveryHarness({ storeRoot: harness.storeRoot });
  await harness2.service.restoreAll();
  assertEqual(findTask(harness2, taskId).status, "interrupted", "task restored interrupted");

  // Break a line in the middle of the (healthy) log AFTER the restore: the
  // failure only surfaces inside the resume critical-section append.
  const eventsPath = join(harness2.storeRoot, workspaceIdOf(projectDir), taskId, "events.jsonl");
  const lines = readFileSync(eventsPath, "utf-8").split("\n").filter((line) => line.trim() !== "");
  lines.splice(1, 0, "{not-json");
  await writeFile(eventsPath, lines.join("\n") + "\n", "utf-8");

  const result = await harness2.service.resume(taskId, 0, { action: "continue", confirmWorkspaceChanges: true });
  assertEqual(result.ok, false, "resume fails on the mid-corrupt log");
  if (!result.ok) {
    assertEqual(result.reason, "internal_error", "internal_error reason");
  }
  const info = findTask(harness2, taskId);
  assertEqual(info.status, "interrupted", "task stays interrupted (never failed)");
  const snap = harness2.service.getAll();
  const issue = snap.recoveryIssues.find((candidate) => candidate.taskId === taskId && candidate.code === "mid_log_corrupt");
  assert(issue !== undefined, "mid_log_corrupt recovery issue surfaced");
  assertEqual(issue?.readOnly, true, "the issue isolates the record read-only");
  assert(harness2.events.records.some((e) => e.name === "agent_task_resume_failed"), "agent_task_resume_failed recorded");
  assert(harness2.events.records.every((e) => e.name !== "agent_task_failed"), "the task was never reported failed");

  assertNoUnhandledRejections();
  rmSync(projectDir, { recursive: true, force: true });
});

await run("resumer: prepare append failures normalize to {ok:false} instead of throwing; nothing leaks", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "pix-resumer-append-"));
  const spec = makeSpec(projectDir, { items: [makeReadyItem()] });
  const store = new FailingAppendStore({
    rootDir: mkdtempSync(join(tmpdir(), "pix-resumer-append-store-")),
    maxTaskBytes: 25 * 1024 * 1024,
    maxWorkspaceBytes: 500 * 1024 * 1024,
  });
  const sessionsDir = store.getTaskSessionDir(spec.workspaceId, spec.taskId);
  const cp = makeDefaultCheckpoint(spec);
  const info = makeInfo(spec, { status: "interrupted" });
  // An unresolved input forces prepare's appendEvent path.
  await writeTaskRecord(store, spec, {
    status: "interrupted",
    events: [
      {
        type: "input_requested",
        request: { taskId: spec.taskId, requestId: "req-1", generation: 0, request: { id: "req-1", questions: [] } },
      },
    ],
    checkpoint: cp,
  });
  const fakeFactory = makeFakeResumerFactory();
  const resumer = new AgentTaskResumer({ store, runtimeFactory: (s) => fakeFactory.factory(s) as never });

  // Storage-limit on the input_settled append: structured {ok:false}, no
  // throw, and the created next-item session file is removed.
  store.nextAppendError = new TaskStorageLimitError("injected workspace storage budget exceeded");
  let threw: unknown;
  let outcome: { ok: boolean; reason?: string } | undefined;
  try {
    outcome = await resumer.prepare(info, cp, { action: "continue", confirmWorkspaceChanges: true });
  } catch (error) {
    threw = error;
  }
  assertEqual(threw === undefined, true, "prepare never throws on a storage-limit append");
  assertEqual(outcome?.ok, false, "prepare returns a structured failure");
  assertEqual(outcome?.reason, "storage_limit", "storage_limit reason");
  assertEqual(existsSync(sessionsDir) ? readdirSync(sessionsDir).length : 0, 0, "no created session file leaks");

  // Mid-log-corrupt append refusal maps to mid_log_corrupt.
  store.nextAppendError = new Error("cannot append to events.jsonl: mid_log_corrupt (recovery-corrupt task)");
  let midThrew: unknown;
  let midOutcome: { ok: boolean; reason?: string } | undefined;
  try {
    midOutcome = await resumer.prepare(info, cp, { action: "continue", confirmWorkspaceChanges: true });
  } catch (error) {
    midThrew = error;
  }
  assertEqual(midThrew === undefined, true, "prepare never throws on a mid-corrupt append");
  assertEqual(midOutcome?.ok, false, "mid-corrupt append returns a structured failure");
  assertEqual(midOutcome?.reason, "mid_log_corrupt", "mid_log_corrupt reason");

  assertNoUnhandledRejections();
  rmSync(projectDir, { recursive: true, force: true });
});

await run("service resume: a prepare-level append failure releases the reservation and keeps interrupted", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "pix-resume-prepfail-"));
  const spec = makeSpec(projectDir, { items: [makeReadyItem()] });
  const storeRoot = mkdtempSync(join(tmpdir(), "pix-resume-prepfail-store-"));
  const store = new FailingAppendStore({
    rootDir: storeRoot,
    maxTaskBytes: 25 * 1024 * 1024,
    maxWorkspaceBytes: 500 * 1024 * 1024,
  });
  const cp = makeDefaultCheckpoint(spec);
  await writeTaskRecord(store, spec, {
    status: "interrupted",
    events: [
      {
        type: "input_requested",
        request: { taskId: spec.taskId, requestId: "req-1", generation: 0, request: { id: "req-1", questions: [] } },
      },
    ],
    checkpoint: cp,
  });
  const harness = makeRecoveryHarness({ storeRoot, store });
  await harness.service.restoreAll();
  assertEqual(findTask(harness, spec.taskId).status, "interrupted", "task hydrates interrupted");

  store.nextAppendError = new TaskStorageLimitError("injected workspace storage budget exceeded");
  const result = await harness.service.resume(spec.taskId, 0, { action: "continue", confirmWorkspaceChanges: true });
  assertEqual(result.ok, false, "resume fails");
  if (!result.ok) {
    assertEqual(result.reason, "storage_limit", "storage_limit reason");
  }
  const info = findTask(harness, spec.taskId);
  assertEqual(info.status, "interrupted", "task stays interrupted");
  assertEqual(info.generation, 0, "generation unchanged (the prepare never completed)");
  const reserved = (await harness.store.getWorkspaceUsage(spec.workspaceId)).reservedBytes;
  assertEqual(reserved, 0, "reservation released");
  assert(harness.events.records.some((e) => e.name === "agent_task_resume_failed"), "agent_task_resume_failed recorded");

  assertNoUnhandledRejections();
  rmSync(projectDir, { recursive: true, force: true });
});

await run("restoreAll: index.generation continues incrementing across restarts", async () => {
  const harness = makeRecoveryHarness();
  const handle = await harness.service.createTaskGroup(makeParams("single", [makeTask(0)]), makeContext(harness), "foreground");
  const taskId = handle.tasks[0].taskId;
  await harness.service.prepareShutdown();
  const ws = workspaceIdOf(PROJECT.physicalPath);
  const genBefore = (await harness.store.readIndex(ws))!.generation;

  const harness2 = makeRecoveryHarness({ storeRoot: harness.storeRoot });
  await harness2.service.restoreAll();
  const marked = await harness2.service.markFailed(taskId, 0, "user_decision");
  assertEqual(marked.ok, true, "mark_failed ok");
  await waitForAsync(async () => {
    const index = await harness2.store.readIndex(ws);
    return index !== null && index.generation > genBefore;
  }, 20000, "index generation incremented");
  const index = await harness2.store.readIndex(ws);
  assertEqual(index?.generation, genBefore + 1, "generation continues from the disk value instead of restarting at 1");

  assertNoUnhandledRejections();
});

await run("dispose waits for the prepared queued runtime's dispose (exit cleanup is never truncated)", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "pix-dispose-queued-"));
  const location = makeLocation(projectDir);
  const harness = makeRecoveryHarness();
  const handle = await harness.service.createTaskGroup(
    makeParams("parallel", [makeTask(0), makeTask(1), makeTask(2), makeTask(3), makeTask(4)]),
    makeContext(harness, { project: location }),
    "foreground",
  );
  const taskIds = handle.tasks.map((task) => task.taskId);
  await harness.service.prepareShutdown();

  const disposeResolvers: Array<() => void> = [];
  const disposedTaskIds: string[] = [];
  const harness2 = makeRecoveryHarness({ storeRoot: harness.storeRoot });
  __setAgentTaskServiceHooksForTests({
    autoBackgroundMsOverride: 0,
    disableAutoRecovery: true,
    runtimeFactory: (spec, input) => {
      const fake = new FakeRuntime(spec);
      fake.input = input;
      fake.dispose = () => {
        disposedTaskIds.push(spec.taskId);
        fake.disposeCalls++;
        return new Promise<void>((resolve) => {
          disposeResolvers.push(resolve);
        });
      };
      return fake as unknown as AgentTaskRuntime;
    },
  });
  await harness2.service.restoreAll();
  for (const taskId of taskIds) {
    const resumed = await harness2.service.resume(taskId, 0, { action: "continue", confirmWorkspaceChanges: true });
    assertEqual(resumed.ok, true, `resume ${taskId} ok`);
  }
  const queuedId = [...harness2.service.getAll().tasks].find((info) => info.status === "queued")!.taskId;

  let disposeSettled = false;
  const disposePromise = harness2.service.dispose("app_shutdown").then(() => {
    disposeSettled = true;
  });
  await drain();
  await drain();
  assertEqual(disposeSettled, false, "dispose does not settle while the prepared queued runtime's dispose is pending");
  assert(disposedTaskIds.includes(queuedId), "the prepared queued runtime's dispose was initiated");
  for (const resolve of disposeResolvers) {
    resolve();
  }
  await disposePromise;
  assertEqual(disposeSettled, true, "dispose settles once the runtime dispose completes");
  assertEqual(findTask(harness2, queuedId).status, "queued", "the frozen pre-status stays queued");

  assertNoUnhandledRejections();
  rmSync(projectDir, { recursive: true, force: true });
});

await run("service resume: a queued resumed task cancelled before its slot disposes the prepared runtime and releases the reservation", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "pix-resume-cancel-"));
  const location = makeLocation(projectDir);
  const harness = makeRecoveryHarness();
  // Five interrupted tasks: resuming them all occupies the 4 global slots and
  // leaves the fifth queued with its prepared (but never started) runtime.
  const handle = await harness.service.createTaskGroup(
    makeParams("parallel", [makeTask(0), makeTask(1), makeTask(2), makeTask(3), makeTask(4)]),
    makeContext(harness, { project: location }),
    "foreground",
  );
  const taskIds = handle.tasks.map((task) => task.taskId);
  await harness.service.prepareShutdown();
  const harness2 = makeRecoveryHarness({ storeRoot: harness.storeRoot });
  await harness2.service.restoreAll();
  for (const taskId of taskIds) {
    const result = await harness2.service.resume(taskId, 0, { action: "continue", confirmWorkspaceChanges: true });
    assertEqual(result.ok, true, `resume ${taskId} ok`);
  }
  const queuedId = [...harness2.service.getAll().tasks].find((info) => info.status === "queued")!.taskId;
  const queuedFake = FakeRuntime.instances.find((candidate) => candidate.spec.taskId === queuedId)!;
  const reservedBefore = (await harness2.store.getWorkspaceUsage(workspaceIdOf(projectDir))).reservedBytes;
  const cancelled = await harness2.service.cancel(queuedId, 1, "user_cancel");
  assertEqual(cancelled.ok, true, "queued resumed task cancels");
  await drain();
  assertEqual(queuedFake.disposeCalls, 1, "prepared queued runtime disposed on cancel");
  const reservedAfter = (await harness2.store.getWorkspaceUsage(workspaceIdOf(projectDir))).reservedBytes;
  assert(reservedAfter < reservedBefore, "resume reservation released on cancel");
  assertEqual(findTask(harness2, queuedId).status, "cancelled", "queued resumed task cancelled");

  assertNoUnhandledRejections();
  rmSync(projectDir, { recursive: true, force: true });
});

await run("service: mark_failed converts interrupted to failed(user_decision); diagnostics metadata-only", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "pix-resume-clear-"));
  const location = makeLocation(projectDir);
  const harness = makeRecoveryHarness();
  // Plain completed task.
  const handle = await harness.service.createTaskGroup(makeParams("parallel", [makeTask(0), makeTask(1)]), makeContext(harness, { project: location }), "foreground");
  const [plainId, runningId] = handle.tasks.map((task) => task.taskId);
  FakeRuntime.instances.find((fake) => fake.spec.taskId === plainId)!.complete();
  await waitFor(() => findTask(harness, plainId).status === "completed", 20000, "plain task completed");
  // Pending-link completed task.
  const linkedHandle = await harness.service.createTaskGroup(
    makeParams("single", [makeTask(2)], { planLink: { planId: "plan-1", version: 1, stepId: "step-0" } }),
    makeContext(harness, { project: location }),
    "foreground",
  );
  const linkedId = linkedHandle.tasks[0].taskId;
  FakeRuntime.instances.find((fake) => fake.spec.taskId === linkedId)!.complete();
  await waitFor(() => findTask(harness, linkedId).status === "completed", 20000, "linked task completed");
  await harness.service.prepareShutdown();

  const harness2 = makeRecoveryHarness({ storeRoot: harness.storeRoot });
  await harness2.service.restoreAll();
  const interrupted = findTask(harness2, runningId);
  assertEqual(interrupted.status, "interrupted", "running task hydrates interrupted");

  // 1.5 (P1): clear_all_terminal is gone (retention owns terminal-record
  // deletion); the pending-link and interrupted protection semantics live in
  // the retention tests.

  // mark_failed on the interrupted task.
  const marked = await harness2.service.markFailed(runningId, 0, "user_decision");
  assertEqual(marked.ok, true, "mark_failed ok");
  const markedInfo = findTask(harness2, runningId);
  assertEqual(markedInfo.status, "failed", "mark_failed -> failed");
  assertEqual(markedInfo.failureReason, "user_decision", "user_decision failure reason");
  assertEqual(markedInfo.errorMessage !== undefined, true, "mark_failed carries a message");
  const staleMark = await harness2.service.markFailed(runningId, 999, "user_decision");
  assertEqual(staleMark.ok, false, "mark_failed stale generation rejected");

  // export_diagnostics: metadata only, never prompt/code/output.
  const diag = await harness2.service.getDiagnostics(runningId);
  assert(diag.fileName.endsWith(".diagnostics.json"), "diagnostics file name");
  assert(!diag.content.includes("do the thing"), "diagnostics never include prompt text");
  assert(!diag.content.includes("final-"), "diagnostics never include tool output");
  assert(diag.content.includes('"diagnostics"'), "diagnostics include error positions");
  const unknown = await harness2.service.getDiagnostics("no-such-task").then(
    () => null,
    (err: unknown) => err,
  );
  assert(unknown !== null, "unknown task diagnostics fail");

  assertNoUnhandledRejections();
  rmSync(projectDir, { recursive: true, force: true });
});

await run("restoreAll: generation one-behind checkpoint compensated; ahead checkpoint surfaces index_corrupt", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "pix-resume-gen-"));
  const storeRoot = mkdtempSync(join(tmpdir(), "pix-resume-gen-store-"));
  const store = new AgentTaskStore({
    rootDir: storeRoot,
    maxTaskBytes: 25 * 1024 * 1024,
    maxWorkspaceBytes: 500 * 1024 * 1024,
  });

  // Task A: the resume's queued state event landed (generation 1) but the
  // generation+1 checkpoint write never happened - the checkpoint is one
  // generation behind and must be compensated, not treated as corruption.
  const specA = makeSpec(projectDir, { items: [makeReadyItem()] });
  await store.initWorkspace(specA.workspaceId);
  const queuedA = makeInfo(specA, { status: "queued", generation: 1 });
  await store.writeMetadata(specA.workspaceId, specA.taskId, {
    schemaVersion: 1,
    spec: specA,
    initialInfo: makeInfo(specA, { status: "queued", generation: 0 }),
  });
  await store.appendEvent(specA.workspaceId, specA.taskId, { type: "state", from: "interrupted", to: "queued", info: queuedA });
  await store.writeCheckpoint(specA.workspaceId, specA.taskId, makeDefaultCheckpoint(specA, { generation: 0, seq: 1 }));

  // Task B: the checkpoint generation is AHEAD of the folded state events.
  const specB = makeSpec(projectDir, { items: [makeReadyItem()] });
  await store.initWorkspace(specB.workspaceId);
  await store.writeMetadata(specB.workspaceId, specB.taskId, {
    schemaVersion: 1,
    spec: specB,
    initialInfo: makeInfo(specB, { status: "running", generation: 0 }),
  });
  await store.appendEvent(specB.workspaceId, specB.taskId, { type: "state", from: "queued", to: "running", info: makeInfo(specB, { status: "running", generation: 1 }) });
  await store.writeCheckpoint(specB.workspaceId, specB.taskId, makeDefaultCheckpoint(specB, { generation: 5, seq: 1 }));

  // ONE shared index carries both tasks (a second write would replace it).
  const wsId = specA.workspaceId;
  await store.writeIndex(wsId, {
    schemaVersion: 1,
    workspaceId: wsId,
    generation: 1,
    lastWriterRunId: "test-run",
    tasks: [
      {
        taskId: specA.taskId,
        workspaceId: wsId,
        parentSessionId: specA.parentSessionId,
        parentToolCallId: specA.parentToolCallId,
        groupId: specA.groupId,
        status: "queued",
        lastCheckpointSeq: 1,
        hasUnclosedToolCall: false,
        updatedAt: Date.now(),
        schemaVersion: 1,
        lastWriterRunId: "test-run",
      },
      {
        taskId: specB.taskId,
        workspaceId: wsId,
        parentSessionId: specB.parentSessionId,
        parentToolCallId: specB.parentToolCallId,
        groupId: specB.groupId,
        status: "running",
        lastCheckpointSeq: 1,
        hasUnclosedToolCall: false,
        updatedAt: Date.now(),
        schemaVersion: 1,
        lastWriterRunId: "test-run",
      },
    ],
  });

  const harness = makeRecoveryHarness({ storeRoot });
  const report = await harness.service.restoreAll();
  const snap = harness.service.getAll();
  const taskA = snap.tasks.find((t) => t.taskId === specA.taskId);
  assert(taskA !== undefined, "one-behind task hydrates");
  assertEqual(taskA?.generation, 1, "hydrated at the folded (state event) generation");
  assertEqual(taskA?.status, "interrupted", "one-behind task hydrates interrupted");
  assertEqual(snap.tasks.some((t) => t.taskId === specB.taskId), false, "ahead checkpoint never forges a task");
  assertEqual(report.corrupted, 1, "ahead checkpoint counts as corrupted");
  const issue = snap.recoveryIssues.find((candidate) => candidate.taskId === specB.taskId);
  assert(issue !== undefined, "ahead checkpoint surfaces a recovery issue");
  assertEqual(issue?.code, "index_corrupt", "index_corrupt code");
  assertEqual(issue?.readOnly, true, "ahead checkpoint is read-only");

  assertNoUnhandledRejections();
  rmSync(projectDir, { recursive: true, force: true });
});

// ============================================================================
// 1.5 (P1): restart auto-recovery (design plan §6.2)
// ============================================================================

await run("auto-recovery: an untouched-workspace interrupted task resumes automatically", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "pix-auto-resume-"));
  const storeRoot = mkdtempSync(join(tmpdir(), "pix-auto-resume-store-"));
  const store = new AgentTaskStore({ rootDir: storeRoot, maxTaskBytes: 25 * 1024 * 1024, maxWorkspaceBytes: 500 * 1024 * 1024 });
  const spec = makeSpec(projectDir, { items: [makeReadyItem()] });
  await writeTaskRecord(store, spec, { status: "running" });

  const harness = makeRecoveryHarness({ storeRoot, autoRecovery: true });
  const report = await harness.service.restoreAll();
  assertEqual(report.interrupted, 1, "task hydrated interrupted");
  assertEqual(report.autoResumed, 1, "auto-recovery resumed it");
  assertEqual(report.autoFailed, 0, "nothing converged to failed");
  const resumed = findTask(harness, spec.taskId);
  assertEqual(resumed.generation, 1, "generation bumped by the automatic resume");
  assert(
    resumed.status === "queued" || resumed.status === "running",
    `auto-resumed task entered queued/running (status=${resumed.status})`,
  );
  assert(harness.events.records.some((event) => event.name === "agent_task_resume_requested"), "agent_task_resume_requested recorded");

  await harness.service.dispose("app_shutdown").catch(() => {});
  assertNoUnhandledRejections();
  rmSync(projectDir, { recursive: true, force: true });
});

await run("auto-recovery: a missing checkpoint converges to failed(resume_blocked), never lingers interrupted", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "pix-auto-nocp-"));
  const storeRoot = mkdtempSync(join(tmpdir(), "pix-auto-nocp-store-"));
  const store = new AgentTaskStore({ rootDir: storeRoot, maxTaskBytes: 25 * 1024 * 1024, maxWorkspaceBytes: 500 * 1024 * 1024 });
  const spec = makeSpec(projectDir);
  await writeTaskRecord(store, spec, { status: "running" });
  rmSync(join(storeRoot, spec.workspaceId, spec.taskId, "checkpoint.json"), { force: true });

  const harness = makeRecoveryHarness({ storeRoot, autoRecovery: true });
  const report = await harness.service.restoreAll();
  assertEqual(report.interrupted, 1, "task hydrated interrupted");
  assertEqual(report.autoResumed, 0, "resume not possible");
  assertEqual(report.autoFailed, 1, "auto-recovery converged it to failed");
  const failed = findTask(harness, spec.taskId);
  assertEqual(failed.status, "failed", "task is failed, not interrupted");
  assertEqual(failed.failureReason, "resume_blocked", "failure code is resume_blocked (never user_decision)");
  assert((failed.errorMessage ?? "").includes("checkpoint_unavailable"), "errorMessage carries the concrete resume reason");
  assert(harness.events.records.some((event) => event.name === "agent_task_failed"), "agent_task_failed recorded");

  await harness.service.dispose("app_shutdown").catch(() => {});
  assertNoUnhandledRejections();
  rmSync(projectDir, { recursive: true, force: true });
});

await run("auto-recovery: workspace fingerprint change is never auto-confirmed -> failed(resume_blocked)", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "pix-auto-changed-"));
  const storeRoot = mkdtempSync(join(tmpdir(), "pix-auto-changed-store-"));
  const store = new AgentTaskStore({ rootDir: storeRoot, maxTaskBytes: 25 * 1024 * 1024, maxWorkspaceBytes: 500 * 1024 * 1024 });
  const spec = makeSpec(projectDir, { items: [makeReadyItem()] });
  // The checkpoint observed a file hash the (now different) workspace cannot
  // reproduce; the fixed decision confirmWorkspaceChanges:false must refuse.
  await writeTaskRecord(store, spec, {
    status: "running",
    checkpoint: makeDefaultCheckpoint(spec, {
      workspaceFingerprint: { isGit: false, observedFileHashes: { "gone-file.txt": "deadbeef".repeat(8) } },
    }),
  });

  const harness = makeRecoveryHarness({ storeRoot, autoRecovery: true });
  const report = await harness.service.restoreAll();
  assertEqual(report.autoFailed, 1, "changed workspace converges to failed");
  const failed = findTask(harness, spec.taskId);
  assertEqual(failed.failureReason, "resume_blocked", "resume_blocked code");
  assert((failed.errorMessage ?? "").includes("workspace_changed"), "errorMessage names workspace_changed");

  await harness.service.dispose("app_shutdown").catch(() => {});
  assertNoUnhandledRejections();
  rmSync(projectDir, { recursive: true, force: true });
});

await run("workflowOwned survives restarts through the index and exempts the group from retention", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "pix-auto-wf-"));
  const storeRoot = mkdtempSync(join(tmpdir(), "pix-auto-wf-store-"));
  const store = new AgentTaskStore({ rootDir: storeRoot, maxTaskBytes: 25 * 1024 * 1024, maxWorkspaceBytes: 500 * 1024 * 1024 });
  // One workflow-owned terminal task (index entry carries the persisted flag)
  // and one ordinary terminal task.
  const wfSpec = makeSpec(projectDir, { groupId: "wf-group" });
  const plainSpec = makeSpec(projectDir, { groupId: "plain-group" });
  const wfCheckpoint = makeDefaultCheckpoint(wfSpec);
  const plainCheckpoint = makeDefaultCheckpoint(plainSpec);
  for (const [spec, cp] of [
    [wfSpec, wfCheckpoint],
    [plainSpec, plainCheckpoint],
  ] as const) {
    const info = { ...makeInfo(spec, { status: "completed" }), endedAt: Date.now(), durationMs: 0 };
    await store.initWorkspace(spec.workspaceId);
    await store.writeMetadata(spec.workspaceId, spec.taskId, { schemaVersion: 1, spec, initialInfo: makeInfo(spec) });
    await store.appendEvent(spec.workspaceId, spec.taskId, { type: "state", from: "running", to: "completed", info });
    await store.writeCheckpoint(spec.workspaceId, spec.taskId, { ...cp, seq: 1 });
  }
  await store.writeIndex(wfSpec.workspaceId, {
    schemaVersion: 1,
    workspaceId: wfSpec.workspaceId,
    generation: 1,
    lastWriterRunId: "test-run",
    tasks: [
      {
        taskId: wfSpec.taskId,
        workspaceId: wfSpec.workspaceId,
        parentSessionId: wfSpec.parentSessionId,
        parentToolCallId: wfSpec.parentToolCallId,
        groupId: wfSpec.groupId,
        status: "completed",
        lastCheckpointSeq: 1,
        hasUnclosedToolCall: false,
        updatedAt: Date.now(),
        schemaVersion: 1,
        lastWriterRunId: "test-run",
        workflowOwned: true,
      },
      {
        taskId: plainSpec.taskId,
        workspaceId: plainSpec.workspaceId,
        parentSessionId: plainSpec.parentSessionId,
        parentToolCallId: plainSpec.parentToolCallId,
        groupId: plainSpec.groupId,
        status: "completed",
        lastCheckpointSeq: 1,
        hasUnclosedToolCall: false,
        updatedAt: Date.now(),
        schemaVersion: 1,
        lastWriterRunId: "test-run",
      },
    ],
  });

  // Restart with every retention window closed: the ordinary terminal record
  // is reclaimed, the workflow-owned one survives (its lifecycle belongs to
  // the workflow engine).
  const harness = makeRecoveryHarness({
    storeRoot,
    autoRecovery: true,
    retentionOverride: { keepCount: 0, keepAgeMs: 0, undeliveredGraceMs: 0 },
  });
  const removed: string[] = [];
  harness.service.onEvent((event) => {
    if (event.type === "task_removed") {
      removed.push(event.taskId);
    }
  });
  await harness.service.restoreAll();
  const deadline = Date.now() + 10_000;
  while (harness.service.getAll().tasks.length > 1) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for the retention pass to reclaim the plain task");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assertEqual(removed.includes(plainSpec.taskId), true, "plain terminal record removed with a task_removed push");
  assertEqual(removed.includes(wfSpec.taskId), false, "workflow-owned record never removed");
  const snap = harness.service.getAll();
  assertEqual(snap.tasks.length, 1, "only the workflow-owned task remains");
  assertEqual(snap.tasks[0]?.taskId, wfSpec.taskId, "the survivor is the workflow-owned task");

  await harness.service.dispose("app_shutdown").catch(() => {});
  assertNoUnhandledRejections();
  rmSync(projectDir, { recursive: true, force: true });
});

// ============================================================================

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
