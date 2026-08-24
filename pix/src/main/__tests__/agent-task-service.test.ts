/**
 * AgentTaskService tests (B3).
 *
 * Covers: 5 tasks within 4 global slots, parallel/chain granularity,
 * loadedAgents undefined -> BUILTIN_AGENTS, ReadonlyModelRegistry model
 * resolution, the project-agent approval three-way race (user / parent signal /
 * host disposed), spec freezing, input triple validation, group detach
 * semantics, cancelled Plan group consumption, group-level auto-background
 * warning/continueForegroundWait/no-restart backgrounding under an injectable
 * short clock, and the §6.3 agent_task_* product events.
 *
 * The real AgentTaskRuntime is replaced by a controllable fake via
 * __setAgentTaskServiceHooksForTests, so no nested session or provider is
 * ever created.
 *
 * Run with: npm exec tsx -- src/main/__tests__/agent-task-service.test.ts
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  AgentDefinition,
  FileChangeSummary,
  LoadAgentsResult,
  TurnDiffSummary,
} from "@earendil-works/pi-coding-agent";
import { isProductEvent, PRODUCT_EVENT_NAMES_V141, type ProductEvent } from "../../shared/product-events.js";
import {
  AGENT_TASK_MAX_RECENT_ACTIVITIES,
  isAgentTaskInfo,
  type AgentTaskActivity,
  type AgentTaskGroupHandle,
  type AgentTaskInfo,
  type AgentTaskInputRequest,
  type AgentTaskPlanLink,
  type AgentTaskSpec,
  type AgentTaskUsage,
} from "../../shared/agent-task-types.js";
import type { SubagentDetails, SubagentSingleResult } from "../../shared/subagent-types.js";
import type { RequestUserInputRequest, RequestUserInputResponse } from "../../shared/types.js";
import type { ProjectLocation } from "../../shared/project-location.js";
import { SettingsStore } from "../settings-store.js";
import type { ProductEventCollector } from "../product-event-collector.js";
import type { SubagentParentRuntimeSnapshot, SubagentTaskItem } from "../subagent/types.js";
import type { AgentTaskInputRouter } from "../agent-task/agent-task-input.js";
import type { AgentTaskRuntime, AgentTaskRuntimeResult } from "../agent-task/agent-task-runtime.js";
import { AgentTaskStore } from "../agent-task/agent-task-store.js";
import { workspaceIdOf } from "../agent-task/agent-task-identity.js";
import {
  AgentTaskService,
  __setAgentTaskServiceHooksForTests,
  type AgentTaskDeliveryContent,
  type AgentTaskServiceEvent,
  type AgentTaskServiceTestHooks,
  type AgentTaskSubmissionContext,
  type CreateTaskParams,
} from "../agent-task/agent-task-service.js";
import { isSubagentDetails } from "../../shared/subagent-types.js";

// ============================================================================
// Test harness (matches subagent-runner.test.ts style)
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

function assertIncludes(actual: string, expected: string, message: string): void {
  if (actual.includes(expected)) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    console.error(`  FAIL: ${message} - expected "${actual}" to include ${JSON.stringify(expected)}`);
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

function makeAgent(name: string, source: AgentDefinition["source"] = "user", model?: string): AgentDefinition {
  return {
    name,
    description: `${name} description`,
    systemPrompt: `${name} system prompt`,
    model,
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

interface ApprovalControls {
  requestUserInput: (request: RequestUserInputRequest, signal?: AbortSignal) => Promise<RequestUserInputResponse>;
  approve: () => void;
  deny: () => void;
  cancelRequest: () => void;
  lastRequest: () => RequestUserInputRequest | undefined;
}

function makeApprovalControls(): ApprovalControls {
  let handler: ((response: RequestUserInputResponse) => void) | undefined;
  let lastRequest: RequestUserInputRequest | undefined;
  const requestUserInput = (request: RequestUserInputRequest): Promise<RequestUserInputResponse> => {
    lastRequest = request;
    return new Promise((resolve) => {
      handler = resolve;
    });
  };
  return {
    requestUserInput,
    approve: () => handler?.({ id: lastRequest?.id ?? "req", answers: { allow_project_agents: "允许" } }),
    deny: () => handler?.({ id: lastRequest?.id ?? "req", answers: { allow_project_agents: "拒绝" } }),
    cancelRequest: () => handler?.({ id: lastRequest?.id ?? "req", answers: {}, cancelled: true }),
    lastRequest: () => lastRequest,
  };
}

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
  /** When false, abort() never settles; complete() can still be called manually. */
  readonly settleOnAbort: boolean;

  constructor(spec: AgentTaskSpec, options?: { settleOnAbort?: boolean }) {
    this.spec = spec;
    this.settleOnAbort = options?.settleOnAbort ?? true;
    FakeRuntime.instances.push(this);
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
    // cancel tests reach the terminal state without extra wiring. Tests that
    // need a genuinely late settle (dispose-freeze scenarios) opt out with
    // settleOnAbort: false and call complete() manually after the abort.
    if (!this.settleOnAbort) {
      return;
    }
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

  resolveInput(requestId: string, response: RequestUserInputResponse): boolean {
    this.resolveInputCalls.push({ requestId, response });
    return true;
  }

  cancelInput(requestId: string): boolean {
    this.cancelInputCalls.push(requestId);
    return true;
  }
}

type AgentTaskRuntimeEventLike =
  | { type: "activity"; activity: AgentTaskActivity }
  | { type: "output"; text: string; truncated: boolean; originalBytes: number }
  | { type: "file_change"; change: FileChangeSummary; aggregate: TurnDiffSummary };

interface Harness {
  service: AgentTaskService;
  store: AgentTaskStore;
  events: FakeCollector;
  settings: SettingsStore;
  approvals: ApprovalControls;
  resolveHostDisposed: () => void;
  hostDisposed: Promise<"host_disposed">;
}

/**
 * Fresh service per harness: real SettingsStore (temp cwd) + fake collector,
 * fake runtimes, auto-background disabled by default unless overridden.
 */
function makeHarness(extraHooks?: Partial<AgentTaskServiceTestHooks>): Harness {
  FakeRuntime.instances = [];
  const cwd = mkdtempSync(join(tmpdir(), "pix-agent-task-service-"));
  const settings = new SettingsStore({ cwd });
  settings.set("enableProductAnalytics", true);
  const events = new FakeCollector() as unknown as ProductEventCollector;
  const approvals = makeApprovalControls();
  let resolveHostDisposed: () => void = () => {};
  const hostDisposed = new Promise<"host_disposed">((resolve) => {
    resolveHostDisposed = () => resolve("host_disposed");
  });
  // 1.4.2 (R2): the service requires a real store + frozen runId.
  const store = new AgentTaskStore({
    rootDir: mkdtempSync(join(tmpdir(), "pix-agent-task-service-store-")),
    maxTaskBytes: 25 * 1024 * 1024,
    maxWorkspaceBytes: 500 * 1024 * 1024,
  });
  const service = new AgentTaskService({ settings, events, store, runId: "test-run-1" });
  __setAgentTaskServiceHooksForTests({
    autoBackgroundMsOverride: 0,
    runtimeFactory: (spec, input) => {
      const fake = new FakeRuntime(spec);
      fake.input = input;
      return fake as unknown as AgentTaskRuntime;
    },
    ...extraHooks,
  });
  return { service, store, events, settings, approvals, resolveHostDisposed, hostDisposed };
}

function makeContext(harness: Harness, overrides?: Partial<AgentTaskSubmissionContext>): AgentTaskSubmissionContext {
  // The fake catalog replaces the built-ins, so it must carry its own
  // general-purpose entry for the default task name to resolve.
  const loaded: LoadAgentsResult = {
    agents: [
      makeAgent("general-purpose", "built-in"),
      makeAgent("user-helper", "user"),
      makeAgent("project-helper", "project"),
    ],
    projectAgentsDir: "E:\\proj\\demo\\.pi\\agents",
    diagnostics: [],
  };
  return {
    parentSessionId: "session-1",
    parentToolCallId: "tool-call-1",
    project: { ...PROJECT },
    agentDir: join(tmpdir(), "pix-agent-task-service-agent"),
    loadedAgents: loaded,
    modelRegistry: {
      getAll: () => [makeModel("alpha", "faux"), makeModel("beta", "faux")],
      find: (provider, modelId) =>
        provider === "faux" && (modelId === "alpha" || modelId === "beta") ? makeModel(modelId, "faux") : undefined,
      hasConfiguredAuth: () => true,
    } as never,
    parentRuntime: { ...PARENT_RUNTIME },
    requestUserInput: harness.approvals.requestUserInput,
    hostDisposed: harness.hostDisposed,
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

function eventsOf(harness: Harness): AgentTaskServiceEvent[] {
  const captured: AgentTaskServiceEvent[] = [];
  harness.service.onEvent((event) => captured.push(event));
  return captured;
}

function byType(events: AgentTaskServiceEvent[], type: AgentTaskServiceEvent["type"]): AgentTaskServiceEvent[] {
  return events.filter((event) => event.type === type);
}

function findTask(harness: Harness, taskId: string): AgentTaskInfo {
  const task = harness.service.getAll().tasks.find((info) => info.taskId === taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }
  return task;
}

async function waitForStatus(harness: Harness, taskId: string, status: AgentTaskInfo["status"]): Promise<void> {
  await waitFor(() => findTask(harness, taskId).status === status, 20000, `task ${taskId} -> ${status}`);
}

// ============================================================================
// Tests
// ============================================================================

async function testFifoSixthSlot(): Promise<void> {
  const harness = makeHarness();
  const context = makeContext(harness);
  const events = eventsOf(harness);
  const tasks = Array.from({ length: 5 }, (_, index) => makeTask(index));

  const handle = await harness.service.createTaskGroup(makeParams("parallel", tasks), context, "foreground");
  assertEqual(handle.tasks.length, 5, "parallel handle lists 5 children");

  const infos = harness.service.getAll().tasks;
  assertEqual(infos.filter((info) => info.status === "running").length, 4, "exactly 4 tasks start immediately");
  assertEqual(infos.filter((info) => info.status === "queued").length, 1, "the 5th task is queued");
  const queued = infos.find((info) => info.status === "queued");
  assertEqual(queued?.queuePosition, 1, "the queued task reports queue position 1");
  assertEqual(FakeRuntime.instances.length, 4, "only 4 runtimes were created");

  // Complete one running task -> the next queued task starts in the freed slot.
  FakeRuntime.instances[0].complete();
  await waitFor(() => FakeRuntime.instances.length === 5, 20000, "5th runtime started after a release");
  assertEqual(harness.service.getAll().tasks.filter((info) => info.status === "running").length, 4, "still at most 4 running after release");
  assertEqual(harness.service.getAll().tasks.filter((info) => info.status === "queued").length, 0, "no queued tasks remain");

  // The task_state events all pass the shared guard.
  const states = byType(events, "task_state") as Array<{ task: AgentTaskInfo }>;
  assert(states.every((event) => isAgentTaskInfo(event.task)), "every task_state payload passes isAgentTaskInfo");

  // Queue-position bookkeeping: cancelling a queued task removes it instantly.
  const secondGroupTasks = Array.from({ length: 5 }, (_, index) => makeTask(index, "user-helper"));
  const handle2 = await harness.service.createTaskGroup(makeParams("parallel", secondGroupTasks), context, "foreground");
  const queued2 = handle2.tasks.find((task) => task.status === "queued");
  assert(queued2 !== undefined, "second batch has a queued child");
  const cancelResult = await harness.service.cancel(queued2!.taskId, queued2!.generation, "user_cancel");
  assertEqual(cancelResult.ok, true, "queued cancel accepted");
  await waitForStatus(harness, queued2!.taskId, "cancelled");
  // The second batch found no free slot (the first batch still runs at the
  // 4-slot cap), so every child stayed queued; the cancel never created a
  // runtime and removed the waiter immediately.
  assertEqual(FakeRuntime.instances.length, 5, "queued cancel never created a runtime");
}

async function testGranularity(): Promise<void> {
  const harness = makeHarness();
  const context = makeContext(harness);

  // parallel: one task per item, each mode=single, groupMode=parallel.
  const parallelHandle = await harness.service.createTaskGroup(
    makeParams("parallel", [makeTask(0), makeTask(1), makeTask(2)]),
    context,
    "foreground",
  );
  assertEqual(parallelHandle.tasks.length, 3, "parallel produces 3 children");
  const parallelTasks = harness.service.getAll().tasks.filter((info) => info.groupId === parallelHandle.groupId);
  assertEqual(parallelTasks.length, 3, "3 parallel tasks exist");
  for (const task of parallelTasks) {
    const spec = FakeRuntime.instances.find((fake) => fake.spec.taskId === task.taskId)?.spec;
    assertEqual(spec?.mode, "single", "parallel child spec mode is single");
    assertEqual(spec?.groupMode, "parallel", "parallel child spec groupMode is parallel");
    assertEqual(task.groupMode, "parallel", "parallel child info groupMode is parallel");
    assertEqual(task.itemSummaries.length, 1, "parallel child carries exactly one item summary");
  }
  const parallelIndexes = parallelTasks.map((task) => task.itemSummaries[0].index).sort();
  assertEqual(JSON.stringify(parallelIndexes), JSON.stringify([0, 1, 2]), "parallel child indexes keep original order");

  // chain: one task with all items in order.
  const chainHandle = await harness.service.createTaskGroup(
    makeParams("chain", [makeTask(0), makeTask(1), makeTask(2)]),
    context,
    "foreground",
  );
  assertEqual(chainHandle.tasks.length, 1, "chain produces a single child");
  const chainTasks = harness.service.getAll().tasks.filter((info) => info.groupId === chainHandle.groupId);
  const chainSpec = FakeRuntime.instances.find((fake) => fake.spec.groupId === chainHandle.groupId)?.spec;
  assertEqual(chainSpec?.mode, "chain", "chain spec mode is chain");
  assertEqual(chainSpec?.groupMode, "chain", "chain spec groupMode is chain");
  assertEqual(chainTasks[0].itemSummaries.length, 3, "chain task carries every item summary");
  assertEqual(JSON.stringify(chainTasks[0].itemSummaries.map((summary) => summary.index)), JSON.stringify([0, 1, 2]), "chain item order preserved");
  assertEqual(chainTasks[0].groupMode, "chain", "chain info groupMode is chain");

  // single: exactly one task/spec. Free earlier slots so the queued chain
  // starts (first completion) and the new single task finds a free slot
  // (second completion) - then its frozen spec is observable.
  FakeRuntime.instances[0].complete();
  await drain();
  FakeRuntime.instances[1].complete();
  await drain();
  const singleHandle = await harness.service.createTaskGroup(makeParams("single", [makeTask(0)]), context, "foreground");
  assertEqual(singleHandle.tasks.length, 1, "single produces one child");
  const singleSpec = FakeRuntime.instances.find((fake) => fake.spec.groupId === singleHandle.groupId)?.spec;
  assert(singleSpec !== undefined, "single task started after a slot freed");
  assertEqual(singleSpec?.mode, "single", "single spec mode is single");
  assertEqual(singleSpec?.groupMode, "single", "single spec groupMode is single");
}

async function testLoadedAgentsFallbackAndFreeze(): Promise<void> {
  const harness = makeHarness();
  // loadedAgents undefined -> BUILTIN_AGENTS must resolve general-purpose.
  const context = makeContext(harness, { loadedAgents: undefined });
  const handle = await harness.service.createTaskGroup(makeParams("single", [makeTask(0)]), context, "foreground");
  assertEqual(handle.tasks.length, 1, "BUILTIN_AGENTS fallback creates the task");
  const spec = FakeRuntime.instances[0].spec;
  assertEqual(spec.items[0].resolution, "ready", "general-purpose resolves from built-ins");
  assertEqual(spec.items[0].agent.name, "general-purpose", "frozen agent name is general-purpose");
  assertEqual(spec.items[0].agent.source, "built-in", "frozen agent source is built-in");

  // Spec freeze: mutate the borrowed catalog after creation; the frozen spec
  // must not observe the mutation, and no getter/closure survives.
  const harness2 = makeHarness();
  const loaded: LoadAgentsResult = {
    agents: [makeAgent("freeze-helper", "user")],
    projectAgentsDir: "E:\\proj\\demo\\.pi\\agents",
    diagnostics: [],
  };
  const context2 = makeContext(harness2, { loadedAgents: loaded });
  const handle2 = await harness2.service.createTaskGroup(makeParams("single", [makeTask(0, "freeze-helper")]), context2, "foreground");
  const spec2 = FakeRuntime.instances[0].spec;
  const originalPrompt = spec2.items[0].agent.systemPrompt;
  loaded.agents[0].systemPrompt = "MUTATED AFTER CREATION";
  loaded.agents[0].tools = ["bash"];
  assertEqual(spec2.items[0].agent.systemPrompt, originalPrompt, "frozen spec does not observe later catalog mutation");
  assertEqual(spec2.items[0].agent.tools, undefined, "frozen spec does not observe later tools mutation");
  const roundTripped = JSON.parse(JSON.stringify(spec2)) as AgentTaskSpec;
  assertEqual(roundTripped.items[0].agent.systemPrompt, originalPrompt, "frozen spec survives JSON round-trip");
  assertEqual(handle2.tasks[0].taskId, spec2.taskId, "handle taskId matches the frozen spec");
  assertEqual(spec2.items[0].model.provider, "faux", "frozen model provider preserved");
}

async function testModelResolution(): Promise<void> {
  const harness = makeHarness();
  const context = makeContext(harness);

  // 1. inherit: definition.model undefined -> parent active model.
  const inheritHandle = await harness.service.createTaskGroup(makeParams("single", [makeTask(0)]), context, "foreground");
  const inheritSpec = FakeRuntime.instances.find((fake) => fake.spec.groupId === inheritHandle.groupId)!.spec;
  assertEqual(inheritSpec.items[0].model.provider, "faux", "inherit model provider comes from the parent snapshot");
  assertEqual(inheritSpec.items[0].model.modelId, "parent-model", "inherit model id comes from the parent snapshot");

  // 2. provider/modelId not found -> failed task, never enqueued.
  const loaded2: LoadAgentsResult = {
    agents: [makeAgent("missing-model-agent", "user", "faux/does-not-exist")],
    projectAgentsDir: "E:\\proj\\demo\\.pi\\agents",
    diagnostics: [],
  };
  const context2 = makeContext(harness, { loadedAgents: loaded2 });
  const handle2 = await harness.service.createTaskGroup(makeParams("single", [makeTask(0, "missing-model-agent")]), context2, "foreground");
  await waitForStatus(harness, handle2.tasks[0].taskId, "failed");
  const task2 = findTask(harness, handle2.tasks[0].taskId);
  assertEqual(task2.failureReason, "model_not_found", "unknown provider/model fails as model_not_found");
  assertEqual(FakeRuntime.instances.length, 1, "preflight failures never occupy a slot");

  // 3. ambiguous bare id -> model_ambiguous.
  const registry3 = {
    getAll: () => [makeModel("shared-id", "faux"), makeModel("shared-id", "other")],
    find: () => undefined,
    hasConfiguredAuth: () => true,
  } as never;
  const context3 = makeContext(harness, {
    loadedAgents: { agents: [makeAgent("ambiguous-agent", "user", "shared-id")], projectAgentsDir: "", diagnostics: [] },
    modelRegistry: registry3,
  });
  const handle3 = await harness.service.createTaskGroup(makeParams("single", [makeTask(0, "ambiguous-agent")]), context3, "foreground");
  await waitForStatus(harness, handle3.tasks[0].taskId, "failed");
  assertEqual(findTask(harness, handle3.tasks[0].taskId).failureReason, "model_ambiguous", "ambiguous bare id fails as model_ambiguous");

  // 4. no configured auth -> model_auth_unavailable.
  const registry4 = {
    getAll: () => [makeModel("no-auth", "faux")],
    find: (provider: string, modelId: string) => (provider === "faux" && modelId === "no-auth" ? makeModel("no-auth", "faux") : undefined),
    hasConfiguredAuth: () => false,
  } as never;
  const context4 = makeContext(harness, {
    loadedAgents: { agents: [makeAgent("no-auth-agent", "user", "faux/no-auth")], projectAgentsDir: "", diagnostics: [] },
    modelRegistry: registry4,
  });
  const handle4 = await harness.service.createTaskGroup(makeParams("single", [makeTask(0, "no-auth-agent")]), context4, "foreground");
  await waitForStatus(harness, handle4.tasks[0].taskId, "failed");
  assertEqual(findTask(harness, handle4.tasks[0].taskId).failureReason, "model_auth_unavailable", "missing auth fails as model_auth_unavailable");

  // 5. unknown agent name -> unknown_agent.
  const handle5 = await harness.service.createTaskGroup(makeParams("single", [makeTask(0, "no-such-agent")]), context, "foreground");
  await waitForStatus(harness, handle5.tasks[0].taskId, "failed");
  assertEqual(findTask(harness, handle5.tasks[0].taskId).failureReason, "unknown_agent", "unknown agent fails as unknown_agent");
}

async function testApprovalRaces(): Promise<void> {
  // 1. User approves: the project agent task proceeds.
  const harness = makeHarness();
  const context = makeContext(harness);
  const projectTask = { ...makeTask(0, "project-helper") };
  const createPromise = harness.service.createTaskGroup(makeParams("single", [projectTask], { agentScope: "both" }), context, "foreground");
  await waitFor(() => harness.approvals.lastRequest() !== undefined, 20000, "approval request surfaced");
  harness.approvals.approve();
  const handle = await createPromise;
  assertEqual(handle.tasks[0].status, "running", "approved project task starts");
  assertEqual(FakeRuntime.instances.length, 1, "approved project task got a runtime");

  // 2. Denial in single: whole task fails project_agent_denied, nothing runs.
  const harness2 = makeHarness();
  const context2 = makeContext(harness2);
  const createPromise2 = harness2.service.createTaskGroup(
    makeParams("single", [{ ...makeTask(0, "project-helper") }], { agentScope: "both" }),
    context2,
    "foreground",
  );
  await waitFor(() => harness2.approvals.lastRequest() !== undefined, 20000, "approval request surfaced (deny)");
  harness2.approvals.deny();
  const handle2 = await createPromise2;
  await waitForStatus(harness2, handle2.tasks[0].taskId, "failed");
  assertEqual(findTask(harness2, handle2.tasks[0].taskId).failureReason, "project_agent_denied", "single denial fails as project_agent_denied");
  assertEqual(FakeRuntime.instances.length, 0, "denied single never creates a runtime");
  const deniedResult = findTask(harness2, handle2.tasks[0].taskId).results[0];
  assertEqual(deniedResult.status, "failed", "denied single result is failed");

  // 3. Denial in parallel: only the project item fails; the user item still enqueues.
  const harness3 = makeHarness();
  const context3 = makeContext(harness3);
  const createPromise3 = harness3.service.createTaskGroup(
    makeParams("parallel", [{ ...makeTask(0, "project-helper") }, { ...makeTask(1) }], { agentScope: "both" }),
    context3,
    "foreground",
  );
  await waitFor(() => harness3.approvals.lastRequest() !== undefined, 20000, "approval request surfaced (parallel deny)");
  harness3.approvals.deny();
  const handle3 = await createPromise3;
  await waitForStatus(harness3, handle3.tasks[0].taskId, "failed");
  assertEqual(findTask(harness3, handle3.tasks[0].taskId).failureReason, "project_agent_denied", "parallel project item denied");
  assertEqual(findTask(harness3, handle3.tasks[1].taskId).status, "running", "parallel user item still runs");
  assertEqual(FakeRuntime.instances.length, 1, "only the user item got a runtime");

  // 4. User cancel of the approval request counts as denial.
  const harness4 = makeHarness();
  const context4 = makeContext(harness4);
  const createPromise4 = harness4.service.createTaskGroup(
    makeParams("single", [{ ...makeTask(0, "project-helper") }], { agentScope: "both" }),
    context4,
    "foreground",
  );
  await waitFor(() => harness4.approvals.lastRequest() !== undefined, 20000, "approval request surfaced (cancel)");
  harness4.approvals.cancelRequest();
  const handle4 = await createPromise4;
  await waitForStatus(harness4, handle4.tasks[0].taskId, "failed");
  assertEqual(findTask(harness4, handle4.tasks[0].taskId).failureReason, "project_agent_denied", "cancelled approval counts as denial");

  // 5. Parent signal during approval: whole group cancelled, nothing enqueues.
  const harness5 = makeHarness();
  const context5 = makeContext(harness5);
  const controller = new AbortController();
  const createPromise5 = harness5.service.createTaskGroup(
    makeParams("parallel", [{ ...makeTask(0, "project-helper") }, { ...makeTask(1) }], { agentScope: "both" }),
    context5,
    "foreground",
    controller.signal,
  );
  await waitFor(() => harness5.approvals.lastRequest() !== undefined, 20000, "approval request surfaced (signal)");
  controller.abort();
  const handle5 = await createPromise5;
  for (const task of handle5.tasks) {
    await waitForStatus(harness5, task.taskId, "cancelled");
  }
  const signalTasks = harness5.service.getAll().tasks.filter((info) => info.groupId === handle5.groupId);
  assert(signalTasks.every((info) => info.results.every((result) => result.status === "aborted")), "signal abort results are aborted");
  assertEqual(FakeRuntime.instances.length, 0, "no runtime after parent signal");

  // 6. hostDisposed during approval: whole group cancelled, classified host_disposed.
  const harness6 = makeHarness();
  const context6 = makeContext(harness6);
  const createPromise6 = harness6.service.createTaskGroup(
    makeParams("single", [{ ...makeTask(0, "project-helper") }], { agentScope: "both" }),
    context6,
    "foreground",
  );
  await waitFor(() => harness6.approvals.lastRequest() !== undefined, 20000, "approval request surfaced (host dispose)");
  harness6.resolveHostDisposed();
  const handle6 = await createPromise6;
  await waitForStatus(harness6, handle6.tasks[0].taskId, "cancelled");
  assertEqual(findTask(harness6, handle6.tasks[0].taskId).results[0].failureReason, "host_disposed", "host dispose classified as host_disposed");
  assertEqual(FakeRuntime.instances.length, 0, "no runtime after host dispose");
}

async function testInputTripleValidation(): Promise<void> {
  const harness = makeHarness();
  const context = makeContext(harness);
  const events = eventsOf(harness);
  const handle = await harness.service.createTaskGroup(makeParams("single", [makeTask(0)]), context, "foreground");
  const taskId = handle.tasks[0].taskId;
  const fake = FakeRuntime.instances[0];

  const controller = new AbortController();
  const request: RequestUserInputRequest = {
    id: "req-1",
    questions: [{ id: "q1", header: "问题", question: "继续吗？" }],
  };
  fake.requestInput(controller, request);

  await waitFor(() => findTask(harness, taskId).status === "waiting_input", 20000, "task enters waiting_input");
  assertEqual(harness.service.getActiveInputRequests().length, 1, "the request is globally active");
  assertEqual(harness.service.getActiveInputRequests()[0].requestId, "req-1", "active request carries requestId");
  const inputEvents = byType(events, "task_input") as Array<{ request: AgentTaskInputRequest }>;
  assertEqual(inputEvents.length, 1, "one task_input event emitted");
  assertEqual(inputEvents[0].request.requestId, "req-1", "task_input event carries the request");

  // Triple validation: every mismatch returns false, never throws.
  assertEqual(harness.service.respondInput("no-such-task", "req-1", 0, { id: "req-1", answers: { q1: "x" } }), false, "unknown task rejected");
  assertEqual(harness.service.respondInput(taskId, "req-1", 99, { id: "req-1", answers: { q1: "x" } }), false, "stale generation rejected");
  assertEqual(harness.service.respondInput(taskId, "req-other", 0, { id: "req-other", answers: { q1: "x" } }), false, "wrong requestId rejected");
  assertEqual(harness.service.respondInput(taskId, "req-1", 0, { id: "req-other", answers: { q1: "x" } }), false, "response.id mismatch rejected");

  // Correct response: router settles, runtime receives the answer, status returns to running.
  assertEqual(harness.service.respondInput(taskId, "req-1", 0, { id: "req-1", answers: { q1: "继续" } }), true, "valid response accepted");
  assertEqual(fake.resolveInputCalls.length, 1, "runtime received the answer");
  assertEqual(fake.resolveInputCalls[0].requestId, "req-1", "runtime received the right requestId");
  await waitForStatus(harness, taskId, "running");
  assertEqual(harness.service.getActiveInputRequests().length, 0, "answered request no longer active");
  const dismissals = byType(events, "task_input_dismissed") as Array<{ taskId: string; requestId: string; reason: string }>;
  assertEqual(dismissals.length, 1, "one task_input_dismissed emitted");
  assertEqual(dismissals[0].reason, "answered", "dismissed reason is answered");

  // cancelInput with a valid triple.
  const controller2 = new AbortController();
  fake.requestInput(controller2, { id: "req-2", questions: [{ id: "q1", header: "问题", question: "继续吗？" }] });
  await waitFor(() => findTask(harness, taskId).status === "waiting_input", 20000, "second input -> waiting_input");
  assertEqual(harness.service.cancelInput(taskId, "req-2", 0), true, "valid cancel accepted");
  assertEqual(fake.cancelInputCalls.length, 1, "runtime received the cancel");
  await waitForStatus(harness, taskId, "running");

  // Signal abort settles the routed request without an explicit respond.
  const controller3 = new AbortController();
  fake.requestInput(controller3, { id: "req-3", questions: [{ id: "q1", header: "问题", question: "继续吗？" }] });
  await waitFor(() => findTask(harness, taskId).status === "waiting_input", 20000, "third input -> waiting_input");
  controller3.abort();
  await waitFor(() => harness.service.getActiveInputRequests().length === 0, 20000, "aborted request removed");
  const dismissalReasons = (byType(events, "task_input_dismissed") as Array<{ reason: string }>).map((event) => event.reason);
  assert(dismissalReasons.includes("aborted"), "signal abort dismisses with reason aborted");
}

async function testGroupDetach(): Promise<void> {
  const harness = makeHarness();
  const context = makeContext(harness);
  const events = eventsOf(harness);
  const handle = await harness.service.createTaskGroup(makeParams("parallel", [makeTask(0), makeTask(1)]), context, "foreground");

  const awaitPromise = harness.service.awaitGroup(handle.groupId);

  // 1.5 (P1): the manual background command is gone; the session-switch path
  // (detachForegroundGroupsForSession) is the detach entry point.
  const detachedHandles = harness.service.detachForegroundGroupsForSession("session-1");
  assertEqual(detachedHandles.length, 1, "session detach returns the group handle");
  assertEqual(detachedHandles[0].groupId, handle.groupId, "detached handle matches the group");
  const awaitedResult = await awaitPromise;
  assertEqual(awaitedResult.kind, "backgrounded", "detached group await resolves backgrounded");
  const backgrounded = awaitedResult as { kind: "backgrounded"; handle: AgentTaskGroupHandle };
  assertEqual(backgrounded.handle.tasks.length, 2, "backgrounded handle lists both children");
  assertEqual(backgrounded.handle.mode, "parallel", "backgrounded handle keeps the mode");

  const after = harness.service.getAll().tasks.filter((info) => info.groupId === handle.groupId);
  assert(after.every((info) => info.presentation === "background"), "every non-terminal child flips to background");
  assert(FakeRuntime.instances.every((fake) => fake.abortCalls === 0), "detach never aborts runtimes (no restart)");
  assertEqual(FakeRuntime.instances.length, 2, "no runtime was recreated");

  // Idempotent: a second session detach finds nothing left to detach.
  const again = harness.service.detachForegroundGroupsForSession("session-1");
  assertEqual(again.length, 0, "second detach is a no-op");

  // awaitGroup on the detached group returns the handle immediately.
  const secondAwait = await harness.service.awaitGroup(handle.groupId);
  assertEqual(secondAwait.kind, "backgrounded", "await on detached group resolves backgrounded immediately");

  // Run-in-background groups never attach: awaitGroup resolves immediately.
  const harness3 = makeHarness();
  const context3 = makeContext(harness3);
  // Subscribe before creation so the background group's own task_state
  // emissions are captured; the outer `events` belongs to the first harness
  // and would make the flow assertion below vacuous.
  const events3 = eventsOf(harness3);
  const handle3 = await harness3.service.createTaskGroup(
    makeParams("single", [makeTask(0)], { runInBackground: true }),
    context3,
    "foreground",
  );
  const backgroundAwait = await harness3.service.awaitGroup(handle3.groupId);
  assertEqual(backgroundAwait.kind, "backgrounded", "direct background group awaits backgrounded immediately");
  assertEqual(events3.filter((event) => event.type === "task_state").length > 0, true, "task events still flow for background groups");
}

async function testDetachedGroupCancelGroup(): Promise<void> {
  const harness = makeHarness();
  const context = makeContext(harness);
  const handle = await harness.service.createTaskGroup(makeParams("single", [makeTask(0)]), context, "foreground");
  const taskId = handle.tasks[0].taskId;
  assertEqual(findTask(harness, taskId).status, "running", "task starts running");

  // Session switch path: detach the foreground group; the task keeps running.
  const detached = harness.service.detachForegroundGroupsForSession("session-1");
  assertEqual(detached.length, 1, "session detach returns the group handle");
  assertEqual(findTask(harness, taskId).presentation, "background", "detached task flips to background");

  // The parent-signal path (facade onAbort -> cancelGroup, 1.4.2 R4) must
  // never cancel a detached group: the just-backgrounded task keeps running
  // (a session switch is not a user_cancel).
  await harness.service.cancelGroup(handle.groupId, "user_cancel");
  assertEqual(FakeRuntime.instances[0].abortCalls, 0, "cancelGroup never aborts a detached group");
  assertEqual(findTask(harness, taskId).status, "running", "detached group task stays running after cancelGroup");
  assertEqual(findTask(harness, taskId).stopReason, undefined, "no stop reason was recorded for the detached task");

  // Explicit per-task IPC cancel (user action on the background task) is
  // unaffected by the guard.
  const explicit = await harness.service.cancel(taskId, handle.tasks[0].generation, "user_cancel");
  assertEqual(explicit.ok, true, "explicit per-task cancel still accepted on a detached group");
  await waitForStatus(harness, taskId, "cancelled");
  assertEqual(FakeRuntime.instances[0].abortCalls, 1, "explicit cancel aborts the runtime");

  // Control: a still-foreground group IS cancelled by cancelGroup.
  const harness2 = makeHarness();
  const context2 = makeContext(harness2);
  const handle2 = await harness2.service.createTaskGroup(makeParams("single", [makeTask(0)]), context2, "foreground");
  await harness2.service.cancelGroup(handle2.groupId, "user_cancel");
  await waitForStatus(harness2, handle2.tasks[0].taskId, "cancelled");
  assertEqual(FakeRuntime.instances[0].abortCalls, 1, "non-detached group cancelGroup still cancels its tasks");
}

async function testAutoBackgroundTimer(): Promise<void> {
  const BASE = 1_000_000;
  const fakeTimers = makeFakeTimers(BASE);
  const AUTO_MS = 20_000; // warning lands 10s before the deadline, both in the future
  const harness = makeHarness({
    now: fakeTimers.now,
    setTimer: fakeTimers.setTimer,
    autoBackgroundMsOverride: AUTO_MS,
  });
  const context = makeContext(harness);
  const events = eventsOf(harness);

  // Foreground group: children mirror the shared deadline/warning.
  const handle = await harness.service.createTaskGroup(makeParams("single", [makeTask(0)]), context, "foreground");
  const taskId = handle.tasks[0].taskId;
  const autoBackground = findTask(harness, taskId).autoBackground;
  assert(autoBackground !== undefined, "foreground child mirrors autoBackground deadline");
  assertEqual(autoBackground!.deadlineAt, BASE + AUTO_MS, "deadline uses the injectable clock");
  assertEqual(autoBackground!.warningAt, BASE + AUTO_MS - 10_000, "warning leads the deadline by 10s");
  assertEqual(autoBackground!.warningActive, false, "warning not active initially");

  // Fire the warning timer: warningActive flips and task_state is emitted.
  fakeTimers.fireMs(10_000);
  assertEqual(findTask(harness, taskId).autoBackground?.warningActive, true, "warning timer activates the warning flag");
  const warningStates = byType(events, "task_state").length;
  assert(warningStates >= 2, "warning emission produced additional task_state events");

  // 1.5 (P1): auto-backgrounding is fully automatic (no continue-wait
  // interaction); the deadline fires and flips the panel presentation only -
  // no restart, no await release, status stays running.
  fakeTimers.fireAll();
  assertEqual(findTask(harness, taskId).status, "running", "auto-background does not restart the task");
  assertEqual(findTask(harness, taskId).presentation, "background", "deadline flips the group to background");
  assertEqual(findTask(harness, taskId).autoBackground, undefined, "auto-background clears the mirrored fields");

  // A second group hits the deadline: panel presentation flips, parent await stays.
  const harness2 = makeHarness({
    now: fakeTimers.now,
    setTimer: fakeTimers.setTimer,
    autoBackgroundMsOverride: AUTO_MS,
  });
  const context2 = makeContext(harness2);
  const handle2 = await harness2.service.createTaskGroup(makeParams("parallel", [makeTask(0), makeTask(1)]), context2, "foreground");
  const awaitPromise = harness2.service.awaitGroup(handle2.groupId);
  const result = await Promise.race([awaitPromise, drain().then(() => "pending" as const)]);
  assertEqual(result, "pending", "foreground await still pending before the deadline");
  fakeTimers.fireMs(AUTO_MS);
  const stillPending = await Promise.race([awaitPromise, drain().then(() => "pending" as const)]);
  assertEqual(stillPending, "pending", "deadline does not release the parent await");
  const after = harness2.service.getAll().tasks.filter((info) => info.groupId === handle2.groupId);
  assert(after.every((info) => info.presentation === "background"), "auto-background flips every child to background");
  assert(after.every((info) => info.autoBackground === undefined), "auto-background clears the mirrored fields");
  assert(FakeRuntime.instances.every((fake) => fake.abortCalls === 0), "auto-background never restarts tasks");
  assertEqual(FakeRuntime.instances.length, 2, "no runtime recreated on auto-background");
  FakeRuntime.instances[0].complete();
  FakeRuntime.instances[1].complete();
  const awaited = await awaitPromise;
  assertEqual(awaited.kind, "completed", "parent await still receives SubagentDetails after UI-only auto-background");
}

async function testForegroundAwaitRebuild(): Promise<void> {
  const harness = makeHarness();
  const context = makeContext(harness);

  // Single completed: awaitGroup rebuilds completed SubagentDetails.
  const handle = await harness.service.createTaskGroup(makeParams("single", [makeTask(0)]), context, "foreground");
  const fake = FakeRuntime.instances[0];
  fake.emitOutput("streamed text", false, 13);
  const awaitPromise = harness.service.awaitGroup(handle.groupId);
  fake.complete();
  const result = await awaitPromise;
  assertEqual(result.kind, "completed", "completed single resolves completed");
  const details = (result as { details: SubagentDetails }).details;
  assert(isSubagentDetails(details), "rebuilt details pass isSubagentDetails");
  assertEqual(details.mode, "single", "rebuilt details keep the mode");
  assertEqual(details.results.length, 1, "rebuilt details carry one result");
  assertEqual(details.results[0].status, "completed", "rebuilt result is completed");
  assertEqual(details.results[0].agentName, "general-purpose", "rebuilt result keeps the agent name");
  const finalInfo = findTask(harness, handle.tasks[0].taskId);
  assertEqual(finalInfo.finalOutput, "final-" + handle.tasks[0].taskId, "task finalOutput reflects the terminal text");

  // Parallel mixed outcome: failed kind, results in original order.
  const harness2 = makeHarness();
  const context2 = makeContext(harness2);
  const handle2 = await harness2.service.createTaskGroup(makeParams("parallel", [makeTask(0), makeTask(1)]), context2, "foreground");
  const awaitPromise2 = harness2.service.awaitGroup(handle2.groupId);
  FakeRuntime.instances[0].complete();
  FakeRuntime.instances[1].complete({
    status: "failed",
    results: [
      {
        id: "f1",
        index: 1,
        agentName: "general-purpose",
        agentSource: "unknown",
        description: "Task 1 description",
        status: "failed",
        finalOutput: "",
        outputTruncated: false,
        originalOutputBytes: 0,
        toolUseCount: 0,
        activities: [],
        usage: emptyUsage(),
        failureReason: "api_error",
        errorMessage: "boom",
        endedAt: 2000,
        durationMs: 1000,
      },
    ],
  });
  const result2 = await awaitPromise2;
  assertEqual(result2.kind, "failed", "mixed parallel resolves failed");
  const details2 = (result2 as { details: SubagentDetails }).details;
  assertEqual(JSON.stringify(details2.results.map((result) => result.status)), JSON.stringify(["completed", "failed"]), "results keep original order");
  assertEqual(details2.results[1].failureReason, "api_error", "failed result keeps its reason");

  // Cancelled maps to the legacy aborted result semantics.
  const harness3 = makeHarness();
  const context3 = makeContext(harness3);
  const handle3 = await harness3.service.createTaskGroup(makeParams("single", [makeTask(0)]), context3, "foreground");
  const awaitPromise3 = harness3.service.awaitGroup(handle3.groupId);
  await harness3.service.cancel(handle3.tasks[0].taskId, 0, "user_cancel");
  const result3 = await awaitPromise3;
  assertEqual(result3.kind, "failed", "cancelled group resolves failed");
  const details3 = (result3 as { details: SubagentDetails }).details;
  assert(details3.results.every((result) => result.status === "aborted"), "cancelled maps to aborted results");
  assertEqual(details3.results[0].failureReason, "aborted", "aborted result keeps failureReason aborted");
}

async function testPlanGroupConsumption(): Promise<void> {
  const harness = makeHarness();
  const context = makeContext(harness);
  const link: AgentTaskPlanLink = { planId: "plan-1", version: 1, stepId: "step-1" };
  const handle = await harness.service.createTaskGroup(
    makeParams("single", [makeTask(0)], { planLink: link }),
    context,
    "foreground",
  );
  const taskId = handle.tasks[0].taskId;
  assertEqual(findTask(harness, taskId).planLinkState, "pending", "plan-linked task starts pending");

  // Cancel the whole group (the fake runtime settles on abort).
  await harness.service.cancel(taskId, 0, "user_cancel");
  await waitForStatus(harness, taskId, "cancelled");

  // A cancelled Plan group is still consumable.
  const groupResult = await harness.service.getPlanTaskGroupResult(handle.groupId, link);
  assertEqual(groupResult.ok, true, "cancelled group result readable");
  if (groupResult.ok) {
    assertEqual(groupResult.status, "cancelled", "cancelled group status is cancelled");
    assertEqual(groupResult.taskIds.length, 1, "group result lists the task id");
    assertIncludes(groupResult.summary, "cancelled", "group summary lists the status");
  }

  // Consumption is idempotent.
  await harness.service.confirmPlanTaskGroupConsumed(handle.groupId, link);
  await harness.service.confirmPlanTaskGroupConsumed(handle.groupId, link);
  assertEqual(findTask(harness, taskId).planLinkState, "consumed", "consumption is idempotent");
  // 1.5 (P1): pending Plan links stay protected from the retention pass (the
  // manual clear is gone; the exemption is asserted in the retention tests).

  // Link mismatch is rejected for consumption.
  const harness2 = makeHarness();
  const context2 = makeContext(harness2);
  const handle2 = await harness2.service.createTaskGroup(
    makeParams("single", [makeTask(0)], { planLink: link }),
    context2,
    "foreground",
  );
  const mismatched = await harness2.service.getPlanTaskGroupResult(handle2.groupId, { planId: "plan-x", version: 9, stepId: "step-9" });
  assertEqual(mismatched.ok, false, "link mismatch rejected");

  // Release path.
  await harness2.service.cancel(handle2.tasks[0].taskId, 0, "user_cancel");
  await waitForStatus(harness2, handle2.tasks[0].taskId, "cancelled");
  await harness2.service.releasePlanTaskGroup(handle2.groupId, link, "plan_cancelled");
  assertEqual(findTask(harness2, handle2.tasks[0].taskId).planLinkState, "released", "release flips to released");
}

async function testDeliverySink(): Promise<void> {
  const harness = makeHarness();
  const context = makeContext(harness);
  const handle = await harness.service.createTaskGroup(makeParams("single", [makeTask(0)]), context, "foreground");
  const taskId = handle.tasks[0].taskId;
  const fake = FakeRuntime.instances[0];
  fake.complete();
  await waitForStatus(harness, taskId, "completed");

  // No sink -> target_session_not_open.
  const noSink = await harness.service.sendResultToSession(taskId, 0, "session-target");
  assertEqual(noSink.ok, false, "missing sink rejected");
  assertEqual(noSink.reason, "target_session_not_open", "reason is target_session_not_open");

  // Wrong workspace -> workspace_mismatch.
  const delivered: Array<{ content: unknown }> = [];
  harness.service.registerSessionDeliverySink("session-target", "other-workspace", async (content) => {
    delivered.push({ content });
  });
  const wrongWorkspace = await harness.service.sendResultToSession(taskId, 0, "session-target");
  assertEqual(wrongWorkspace.ok, false, "wrong workspace rejected");
  assertEqual(wrongWorkspace.reason, "workspace_mismatch", "reason is workspace_mismatch");

  // Matching sink: delivered once, recorded, duplicate needs confirmation.
  const taskWorkspace = findTask(harness, taskId).workspaceId;
  harness.service.registerSessionDeliverySink("session-target", taskWorkspace, async (content) => {
    delivered.push({ content });
  });
  const deliveredOnce = await harness.service.sendResultToSession(taskId, 0, "session-target");
  assertEqual(deliveredOnce.ok, true, "delivery succeeds");
  assertEqual(delivered.length, 1, "sink called exactly once");
  assert(findTask(harness, taskId).deliveredSessionIds.includes("session-target"), "delivered session recorded");
  const duplicate = await harness.service.sendResultToSession(taskId, 0, "session-target");
  assertEqual(duplicate.ok, false, "duplicate delivery rejected without confirmation");
  assertEqual(duplicate.reason, "duplicate_delivery", "duplicate reason is duplicate_delivery");
  const confirmed = await harness.service.sendResultToSession(taskId, 0, "session-target", true);
  assertEqual(confirmed.ok, true, "duplicate delivery allowed with confirmation");
  assertEqual(delivered.length, 2, "confirmed duplicate reaches the sink");

  // Busy sink surfaces its reason through the rejection.
  harness.service.registerSessionDeliverySink("session-busy", taskWorkspace, async () => {
    throw new Error("target_session_busy");
  });
  const busy = await harness.service.sendResultToSession(taskId, 0, "session-busy");
  assertEqual(busy.ok, false, "busy sink rejected");
  assertEqual(busy.reason, "target_session_busy", "busy reason surfaces");

  // Stale generation rejected before any side effect.
  const stale = await harness.service.sendResultToSession(taskId, 99, "session-target");
  assertEqual(stale.ok, false, "stale generation rejected");
  assertEqual(stale.reason, "stale_generation", "stale reason is stale_generation");
}

async function testAutoDeliverOnDetachedComplete(): Promise<void> {
  const harness = makeHarness();
  const context = makeContext(harness);
  const delivered: AgentTaskDeliveryContent[] = [];
  const handle = await harness.service.createTaskGroup(makeParams("single", [makeTask(0)]), context, "foreground");
  const taskId = handle.tasks[0].taskId;
  const workspaceId = findTask(harness, taskId).workspaceId;
  harness.service.registerSessionDeliverySink("session-1", workspaceId, async (content) => {
    delivered.push(content);
  });

  const awaitPromise = harness.service.awaitGroup(handle.groupId);
  // 1.5 (P1): detach via the session-switch path (manual background is gone).
  harness.service.detachForegroundGroupsForSession("session-1");
  const detached = await awaitPromise;
  assertEqual(detached.kind, "backgrounded", "session detach releases the parent await");

  FakeRuntime.instances[0].complete();
  await waitForStatus(harness, taskId, "completed");
  await waitFor(() => delivered.length === 1, 20000, "detached completion auto-delivers to the parent session");
  assertEqual(delivered[0].taskId, taskId, "auto-delivery carries the task id");
  assertEqual(delivered[0].status, "completed", "auto-delivery carries the terminal status");
  assert(findTask(harness, taskId).deliveredSessionIds.includes("session-1"), "parent session recorded as delivered");

  // Foreground completion still returns details and does not auto-deliver.
  const harness2 = makeHarness();
  const context2 = makeContext(harness2);
  const foregroundDelivered: AgentTaskDeliveryContent[] = [];
  const handle2 = await harness2.service.createTaskGroup(makeParams("single", [makeTask(0)]), context2, "foreground");
  const taskId2 = handle2.tasks[0].taskId;
  harness2.service.registerSessionDeliverySink("session-1", findTask(harness2, taskId2).workspaceId, async (content) => {
    foregroundDelivered.push(content);
  });
  const await2 = harness2.service.awaitGroup(handle2.groupId);
  FakeRuntime.instances[0].complete();
  const result2 = await await2;
  assertEqual(result2.kind, "completed", "foreground await still returns details");
  await drain();
  assertEqual(foregroundDelivered.length, 0, "foreground completion does not auto-deliver");

  // Plan-linked detached tasks keep the Plan consumption path; no chat inject.
  const harness3 = makeHarness();
  const context3 = makeContext(harness3);
  const planDelivered: AgentTaskDeliveryContent[] = [];
  const link: AgentTaskPlanLink = { planId: "plan-1", version: 1, stepId: "step-1" };
  const handle3 = await harness3.service.createTaskGroup(
    makeParams("single", [makeTask(0)], { planLink: link }),
    context3,
    "foreground",
  );
  const taskId3 = handle3.tasks[0].taskId;
  harness3.service.registerSessionDeliverySink("session-1", findTask(harness3, taskId3).workspaceId, async (content) => {
    planDelivered.push(content);
  });
  harness3.service.detachForegroundGroupsForSession("session-1");
  FakeRuntime.instances[0].complete();
  await waitForStatus(harness3, taskId3, "completed");
  await drain();
  assertEqual(planDelivered.length, 0, "plan-linked tasks skip auto-delivery");

  // Direct run_in_background also auto-delivers on completion.
  const harness4 = makeHarness();
  const context4 = makeContext(harness4);
  const directDelivered: AgentTaskDeliveryContent[] = [];
  const handle4 = await harness4.service.createTaskGroup(
    makeParams("single", [makeTask(0)], { runInBackground: true }),
    context4,
    "foreground",
  );
  const taskId4 = handle4.tasks[0].taskId;
  harness4.service.registerSessionDeliverySink("session-1", findTask(harness4, taskId4).workspaceId, async (content) => {
    directDelivered.push(content);
  });
  FakeRuntime.instances[0].complete();
  await waitForStatus(harness4, taskId4, "completed");
  await waitFor(() => directDelivered.length === 1, 20000, "direct background completion auto-delivers");
  assertEqual(directDelivered[0].taskId, taskId4, "direct background delivery carries the task id");
}

async function testDisposeAndStopReasons(): Promise<void> {
  const harness = makeHarness();
  const context = makeContext(harness);
  const events = eventsOf(harness);
  const handle = await harness.service.createTaskGroup(makeParams("parallel", [makeTask(0), makeTask(1), makeTask(2), makeTask(3), makeTask(4)]), context, "foreground");
  const taskIds = handle.tasks.map((task) => task.taskId);
  const queuedId = handle.tasks.find((task) => task.status === "queued")!.taskId;
  assertEqual(queuedId !== undefined, true, "one task is queued before dispose");

  await harness.service.dispose("app_shutdown");
  // 1.4.2 (R2): dispose without prepareShutdown only aborts and freezes - the
  // tasks keep their pre-shutdown status (never cancelled, no synthesized
  // results, no endedAt), so a restart hydrates them as interrupted.
  await drain();
  const afterDispose = harness.service.getAll().tasks;
  assertEqual(afterDispose.filter((info) => info.status === "running").length, 4, "dispose keeps the running pre-status frozen");
  assertEqual(afterDispose.filter((info) => info.status === "queued").length, 1, "dispose keeps the queued pre-status frozen");
  assert(afterDispose.every((info) => info.stopReason === "app_shutdown"), "frozen tasks carry the app_shutdown stopReason");
  assert(afterDispose.every((info) => info.endedAt === undefined), "frozen tasks never get an endedAt");
  assert(FakeRuntime.instances.filter((fake) => fake.abortCalls > 0).length >= 4, "running runtimes were aborted");
  assertEqual(FakeRuntime.instances.length, 4, "queued task never got a runtime");

  // A genuinely late settle (arriving after dispose's abort) never overwrites
  // the freeze: the default fake settles as cancelled inside abort(), so a
  // complete() after dispose would be a no-op. This runtime opts out of
  // settle-on-abort and is completed manually only after the dispose freeze.
  const harness3 = makeHarness({
    runtimeFactory: (spec, input) => {
      const fake = new FakeRuntime(spec, { settleOnAbort: false });
      fake.input = input;
      return fake as unknown as AgentTaskRuntime;
    },
  });
  const context3 = makeContext(harness3);
  const handle3 = await harness3.service.createTaskGroup(makeParams("single", [makeTask(0)]), context3, "foreground");
  const lateTaskId = handle3.tasks[0].taskId;
  const lateFake = FakeRuntime.instances[0];
  assertEqual(lateFake.abortCalls, 0, "runtime not aborted before dispose");
  // Dispose freezes synchronously, then awaits the in-flight run; the manual
  // cancelled settle lands after the freeze (and after abort) - the exact
  // window the _finalizeTask preShutdownStatus guard protects.
  const disposePromise = harness3.service.dispose("app_shutdown");
  lateFake.complete({ status: "cancelled" });
  await disposePromise;
  await drain();
  assertEqual(lateFake.abortCalls, 1, "dispose aborted the runtime");
  assertEqual(findTask(harness3, lateTaskId).status, "running", "late settle after dispose does not overwrite the frozen pre-status");
  assertEqual(findTask(harness3, lateTaskId).stopReason, "app_shutdown", "late settle does not clear the frozen stopReason");
  const staleCancel = await harness.service.cancel(taskIds[0], 0, "user_cancel");
  assertEqual(staleCancel.ok, false, "cancel after dispose is rejected");
  assertEqual(staleCancel.reason, "service_disposed", "reason is service_disposed");
  void queuedId;

  // dispose settles pending inputs as shutdown.
  const harness2 = makeHarness();
  const context2 = makeContext(harness2);
  const events2 = eventsOf(harness2);
  const handle2 = await harness2.service.createTaskGroup(makeParams("single", [makeTask(0)]), context2, "foreground");
  const fake2 = FakeRuntime.instances[0];
  const controller = new AbortController();
  fake2.requestInput(controller, { id: "req-dispose", questions: [{ id: "q1", header: "问题", question: "继续吗？" }] });
  await waitFor(() => findTask(harness2, handle2.tasks[0].taskId).status === "waiting_input", 20000, "task waiting for input");
  await harness2.service.dispose("app_shutdown");
  const dismissalReasons = (byType(events2, "task_input_dismissed") as Array<{ reason: string }>).map((event) => event.reason);
  assert(dismissalReasons.includes("shutdown"), "dispose settles pending input as shutdown");
}

async function testShutdownInputSettleFreeze(): Promise<void> {
  // prepareShutdown path: the frozen waiting_input fact survives the late
  // input settle - no status rewrite, no state event, no index rewrite.
  const harness = makeHarness();
  const context = makeContext(harness);
  const events = eventsOf(harness);
  const handle = await harness.service.createTaskGroup(makeParams("single", [makeTask(0)]), context, "foreground");
  const taskId = handle.tasks[0].taskId;
  const fake = FakeRuntime.instances[0];

  // Enter waiting_input through the service's real router (the fake runtime
  // forwards enqueue to it).
  const controller = new AbortController();
  fake.requestInput(controller, { id: "req-freeze", questions: [{ id: "q1", header: "问题", question: "继续吗？" }] });
  await waitFor(() => findTask(harness, taskId).status === "waiting_input", 20000, "task waiting for input");

  await harness.service.prepareShutdown();
  assertEqual(findTask(harness, taskId).status, "waiting_input", "frozen task keeps waiting_input");

  // The bounded abort's late settle (the request signal fires) must not
  // rewrite the frozen fact back to running.
  controller.abort();
  await drain();
  assertEqual(findTask(harness, taskId).status, "waiting_input", "late input settle never rewrites the frozen waiting_input");
  const dismissals = (byType(events, "task_input_dismissed") as Array<{ reason: string }>).map((event) => event.reason);
  assert(dismissals.includes("aborted"), "aborted settle still dismisses the input request");

  // On disk: the log's last state event stays waiting_input and the index
  // records the frozen fact (no wait_input -> running rewrite).
  const ws = workspaceIdOf(PROJECT.physicalPath);
  const read = await harness.store.readTask(ws, taskId);
  const states = read.events.filter((event) => event.type === "state") as Array<{ to: string }>;
  assertEqual(states[states.length - 1].to, "waiting_input", "log's last state event stays waiting_input");
  const index = await harness.store.readIndex(ws);
  const indexEntry = index?.tasks.find((entry) => entry.taskId === taskId);
  assertEqual(indexEntry?.status, "waiting_input", "index status stays waiting_input");
  assertEqual(indexEntry?.preShutdownStatus, "waiting_input", "index preShutdownStatus is the true waiting_input");

  // Emergency dispose path: settleOnShutdown runs AFTER the freeze, so the
  // frozen pre-status is the true waiting_input and the settle never lands on
  // disk as a running rewrite.
  const harness2 = makeHarness();
  const context2 = makeContext(harness2);
  const handle2 = await harness2.service.createTaskGroup(makeParams("single", [makeTask(0)]), context2, "foreground");
  const taskId2 = handle2.tasks[0].taskId;
  const fake2 = FakeRuntime.instances[0];
  const controller2 = new AbortController();
  fake2.requestInput(controller2, { id: "req-dispose-freeze", questions: [{ id: "q1", header: "问题", question: "继续吗？" }] });
  await waitFor(() => findTask(harness2, taskId2).status === "waiting_input", 20000, "second task waiting for input");
  await harness2.service.dispose("app_shutdown");
  await drain();
  assertEqual(findTask(harness2, taskId2).status, "waiting_input", "dispose settle never rewrites the frozen waiting_input");
  const read2 = await harness2.store.readTask(ws, taskId2);
  const states2 = read2.events.filter((event) => event.type === "state") as Array<{ to: string }>;
  assertEqual(states2[states2.length - 1].to, "waiting_input", "dispose log's last state event stays waiting_input");
  const index2 = await harness2.store.readIndex(ws);
  const entry2 = index2?.tasks.find((entry) => entry.taskId === taskId2);
  assertEqual(entry2?.status, "waiting_input", "dispose index status stays the true waiting_input");
}

async function testConcurrentInputRequests(): Promise<void> {
  const harness = makeHarness();
  const context = makeContext(harness);
  const handle = await harness.service.createTaskGroup(makeParams("single", [makeTask(0)]), context, "foreground");
  const taskId = handle.tasks[0].taskId;
  const fake = FakeRuntime.instances[0];

  const controllerA = new AbortController();
  const controllerB = new AbortController();
  fake.requestInput(controllerA, { id: "req-a", questions: [{ id: "q1", header: "问题", question: "继续吗？" }] });
  await waitFor(() => findTask(harness, taskId).status === "waiting_input", 20000, "first request -> waiting_input");
  fake.requestInput(controllerB, { id: "req-b", questions: [{ id: "q1", header: "问题", question: "继续吗？" }] });
  await drain();
  assertEqual(harness.service.getActiveInputRequests().length, 2, "two requests pending for the task");

  // Settling the first request keeps waiting_input (the second is pending).
  assertEqual(harness.service.respondInput(taskId, "req-a", 0, { id: "req-a", answers: { q1: "x" } }), true, "first response accepted");
  await drain();
  assertEqual(findTask(harness, taskId).status, "waiting_input", "first settle keeps waiting_input while the second request is pending");
  assertEqual(harness.service.getActiveInputRequests().length, 1, "one request still pending");

  // Settling the last request returns the task to running.
  assertEqual(harness.service.respondInput(taskId, "req-b", 0, { id: "req-b", answers: { q1: "x" } }), true, "second response accepted");
  await waitFor(() => findTask(harness, taskId).status === "running", 20000, "last settle -> running");
  assertEqual(harness.service.getActiveInputRequests().length, 0, "no requests pending");
}

async function testShutdownInputRequestFreeze(): Promise<void> {
  const harness = makeHarness();
  const context = makeContext(harness);
  const events = eventsOf(harness);
  const handle = await harness.service.createTaskGroup(makeParams("single", [makeTask(0)]), context, "foreground");
  const taskId = handle.tasks[0].taskId;
  const fake = FakeRuntime.instances[0];

  await harness.service.prepareShutdown();
  assertEqual(findTask(harness, taskId).status, "running", "frozen task keeps running");

  // A late input request after the freeze must not rewrite the frozen status
  // to waiting_input; the input itself still surfaces.
  const controller = new AbortController();
  fake.requestInput(controller, { id: "req-late", questions: [{ id: "q1", header: "问题", question: "继续吗？" }] });
  await drain();
  assertEqual(findTask(harness, taskId).status, "running", "late input request never rewrites the frozen running");
  const inputEvents = byType(events, "task_input");
  assertEqual(inputEvents.length, 1, "the late input still surfaces as task_input");

  // On disk: no waiting_input state event / index rewrite.
  const ws = workspaceIdOf(PROJECT.physicalPath);
  const read = await harness.store.readTask(ws, taskId);
  const states = read.events.filter((event) => event.type === "state") as Array<{ to: string }>;
  assertEqual(states[states.length - 1].to, "running", "log's last state event stays running");
  const index = await harness.store.readIndex(ws);
  const indexEntry = index?.tasks.find((entry) => entry.taskId === taskId);
  assertEqual(indexEntry?.status, "running", "index status stays running");
}

function isTerminalStatusLike(status: AgentTaskInfo["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

async function testProductEvents(): Promise<void> {
  const harness = makeHarness();
  const context = makeContext(harness);
  const handle = await harness.service.createTaskGroup(makeParams("single", [makeTask(0)]), context, "foreground");
  const taskId = handle.tasks[0].taskId;
  const fake = FakeRuntime.instances[0];

  // Started was recorded for the runnable task.
  assert(harness.events.records.some((event) => event.name === "agent_task_started"), "agent_task_started recorded");
  assertEqual(PRODUCT_EVENT_NAMES_V141.includes("agent_task_started"), true, "event name is part of the 1.4.1 set");

  // Waiting input.
  const controller = new AbortController();
  fake.requestInput(controller, { id: "req-event", questions: [{ id: "q1", header: "问题", question: "继续吗？" }] });
  await waitFor(() => findTask(harness, taskId).status === "waiting_input", 20000, "task waiting for input");
  assert(harness.events.records.some((event) => event.name === "agent_task_waiting_input"), "agent_task_waiting_input recorded");

  // Completed.
  fake.complete();
  await waitForStatus(harness, taskId, "completed");
  assert(harness.events.records.some((event) => event.name === "agent_task_completed"), "agent_task_completed recorded");

  // Failed (preflight failure never runs).
  const harness2 = makeHarness();
  const context2 = makeContext(harness2);
  const handle2 = await harness2.service.createTaskGroup(makeParams("single", [makeTask(0, "no-such-agent")]), context2, "foreground");
  await waitForStatus(harness2, handle2.tasks[0].taskId, "failed");
  assert(harness2.events.records.some((event) => event.name === "agent_task_failed"), "agent_task_failed recorded");
  const failedEvent = harness2.events.records.find((event) => event.name === "agent_task_failed");
  assertEqual(failedEvent?.payload.errorCategory, "internal_error", "failed event carries an error category");

  // Backgrounded (via the session detach path; manual background is gone).
  const harness3 = makeHarness();
  const context3 = makeContext(harness3);
  const handle3 = await harness3.service.createTaskGroup(makeParams("single", [makeTask(0)]), context3, "foreground");
  harness3.service.detachForegroundGroupsForSession("session-1");
  assert(harness3.events.records.some((event) => event.name === "agent_task_backgrounded"), "agent_task_backgrounded recorded");

  // Cancelled.
  const harness4 = makeHarness();
  const context4 = makeContext(harness4);
  const handle4 = await harness4.service.createTaskGroup(makeParams("single", [makeTask(0)]), context4, "foreground");
  await harness4.service.cancel(handle4.tasks[0].taskId, 0, "user_cancel");
  await waitForStatus(harness4, handle4.tasks[0].taskId, "cancelled");
  assert(harness4.events.records.some((event) => event.name === "agent_task_cancelled"), "agent_task_cancelled recorded");
}

async function testEventThrottle(): Promise<void> {
  const BASE = 5_000_000;
  const fakeTimers = makeFakeTimers(BASE);
  const harness = makeHarness({ now: fakeTimers.now, setTimer: fakeTimers.setTimer, autoBackgroundMsOverride: 0 });
  const context = makeContext(harness);
  const events = eventsOf(harness);
  const handle = await harness.service.createTaskGroup(makeParams("single", [makeTask(0)]), context, "foreground");
  const taskId = handle.tasks[0].taskId;
  const fake = FakeRuntime.instances[0];

  // Three rapid activities: first flushes immediately, the rest merge into
  // one throttled event (the fake clock never advances).
  for (let i = 0; i < 3; i++) {
    fake.emitActivity({
      sequence: i + 1,
      toolCallId: `call-${i}`,
      toolName: "read",
      status: "completed",
      summary: `path-${i}`,
      startedAt: BASE,
      endedAt: BASE + 1,
    });
  }
  const immediate = byType(events, "task_activities") as Array<{ activities: AgentTaskActivity[] }>;
  assertEqual(immediate.length, 1, "first activity emits immediately");
  assertEqual(immediate[0].activities.length, 1, "first event carries a single activity");

  fakeTimers.fireAll();
  const afterTimer = byType(events, "task_activities") as Array<{ activities: AgentTaskActivity[] }>;
  assertEqual(afterTimer.length, 2, "remaining activities merge into one throttled event");
  assertEqual(afterTimer[1].activities.length, 2, "merged event carries both activities");
  assertEqual(JSON.stringify(afterTimer[1].activities.map((activity) => activity.toolCallId)), JSON.stringify(["call-1", "call-2"]), "merged activities keep order");

  // Terminal forces a flush of pending output.
  fake.emitOutput("streamed");
  fake.complete();
  await waitForStatus(harness, taskId, "completed");
  const outputEvents = byType(events, "task_output") as Array<{ output: string }>;
  assert(outputEvents.length >= 1, "output events were emitted");
  const taskInfo = findTask(harness, taskId);
  assertEqual(taskInfo.finalOutput, "final-" + taskId, "task finalOutput is terminal text");
  assert(taskInfo.activities.length <= AGENT_TASK_MAX_RECENT_ACTIVITIES, "activities stay within the bound");
}

async function testLiveToolUseCount(): Promise<void> {
  const harness = makeHarness({ autoBackgroundMsOverride: 0 });
  const context = makeContext(harness);
  const events = eventsOf(harness);
  const handle = await harness.service.createTaskGroup(makeParams("single", [makeTask(0)]), context, "foreground");
  const taskId = handle.tasks[0].taskId;
  const fake = FakeRuntime.instances[0];
  await waitForStatus(harness, taskId, "running");

  fake.emitActivity({
    sequence: 1,
    toolCallId: "call-live-1",
    toolName: "read",
    status: "running",
    summary: "src/main.ts",
    startedAt: Date.now(),
  });
  fake.emitActivity({
    sequence: 2,
    toolCallId: "call-live-1",
    toolName: "read",
    status: "completed",
    summary: "src/main.ts",
    startedAt: Date.now(),
    endedAt: Date.now(),
  });
  fake.emitActivity({
    sequence: 3,
    toolCallId: "call-live-2",
    toolName: "grep",
    status: "running",
    summary: "DEFAULT_MAX_TURNS",
    startedAt: Date.now(),
  });

  const info = findTask(harness, taskId);
  assertEqual(info.toolUseCount, 2, "running activities increment toolUseCount; completions do not");
  const activityEvents = byType(events, "task_activities") as Array<{
    activities: AgentTaskActivity[];
    toolUseCount?: number;
  }>;
  assert(activityEvents.length >= 1, "live activities were forwarded");
  assertEqual(activityEvents[0].toolUseCount, 1, "first flush carries the live toolUseCount");
}

// ============================================================================
// Runner
// ============================================================================

async function main(): Promise<void> {
  await run("global FIFO: 5 tasks within 4 slots, queued cancel removal", testFifoSixthSlot);
  await run("granularity: parallel children / chain / single", testGranularity);
  await run("loadedAgents undefined -> BUILTIN_AGENTS + spec freeze", testLoadedAgentsFallbackAndFreeze);
  await run("ReadonlyModelRegistry model resolution", testModelResolution);
  await run("project approval: user / signal / hostDisposed three-way race", testApprovalRaces);
  await run("input routing: triple validation + per-task FIFO", testInputTripleValidation);
  await run("group detach: session detach / direct background", testGroupDetach);
  await run("detached group: cancelGroup never cancels; explicit cancel still works", testDetachedGroupCancelGroup);
  await run("auto-background: injectable clock warning / pure-automatic flip", testAutoBackgroundTimer);
  await run("foreground await: SubagentDetails rebuild + cancelled aborted semantics", testForegroundAwaitRebuild);
  await run("Plan group consumption", testPlanGroupConsumption);
  await run("result delivery sink", testDeliverySink);
  await run("detached completion auto-delivers to the parent session", testAutoDeliverOnDetachedComplete);
  await run("dispose: bounded shutdown + stop reasons", testDisposeAndStopReasons);
  await run("shutdown input settle never rewrites the frozen preShutdownStatus", testShutdownInputSettleFreeze);
  await run("concurrent input requests: last settle returns the task to running", testConcurrentInputRequests);
  await run("shutdown input request never rewrites the frozen preShutdownStatus", testShutdownInputRequestFreeze);
  await run("product events (§6.3 agent_task_*)", testProductEvents);
  await run("event throttle: bounded merge of activities/output", testEventThrottle);
  await run("live toolUseCount increments on running activities", testLiveToolUseCount);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

void main();
