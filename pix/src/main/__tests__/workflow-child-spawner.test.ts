/**
 * Workflow child spawner tests (S4).
 *
 * Section A drives the REAL AgentTaskService (fake runtime factory, same
 * harness shape as agent-task-service.test.ts) through the REAL
 * createAgentTaskChildSpawner: provider mapping, the locked spawn parameters
 * (single/user/foreground/workflowExtras), ChildResult projection for every
 * awaitGroup outcome, preflight modelOverride resolution, queued cancel ->
 * script null, the workflowOwned background() refusal and the disabled
 * auto-background timer.
 *
 * Section B runs the REAL AgentTaskRuntime (faux pi-ai provider, real
 * createAgentSession) over schema children: the capture tool is injected, a
 * child that never submits fails with invalid_parameters, a submitted value is
 * validated (retry works), the tools allowlist is merged with
 * submit_workflow_result, and the no-schema path behaves exactly as before.
 *
 * Run with: npm exec tsx -- src/main/__tests__/workflow-child-spawner.test.ts
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  Usage,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, type Api } from "@earendil-works/pi-ai";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { AgentDefinition, LoadAgentsResult } from "@earendil-works/pi-coding-agent";
import { isProductEvent, type ProductEvent } from "../../shared/product-events.js";
import type { AgentTaskInfo, AgentTaskSpec, AgentTaskUsage } from "../../shared/agent-task-types.js";
import type { SubagentParentRuntimeSnapshot } from "../subagent/types.js";
import type { AgentTaskInputRouter } from "../agent-task/agent-task-input.js";
import { AgentTaskRuntime } from "../agent-task/agent-task-runtime.js";
import { AgentTaskStore } from "../agent-task/agent-task-store.js";
import { workspaceIdOf } from "../agent-task/agent-task-identity.js";
import {
  AgentTaskService,
  __setAgentTaskServiceHooksForTests,
  type AgentTaskServiceTestHooks,
  type AgentTaskSubmissionContext,
  type CreateTaskParams,
} from "../agent-task/agent-task-service.js";
import type { RequestUserInputRequest, RequestUserInputResponse } from "../../shared/types.js";
import type { ProjectLocation } from "../../shared/project-location.js";
import { createAgentTaskChildSpawner, resolveWorkflowAgentType } from "../workflow/child-spawner.js";
import { WorkflowError } from "../workflow/engine/engine.js";
import type { ChildStartRequest } from "../workflow/engine/child-types.js";
import type { WorkflowParentRef } from "../workflow/engine/runtime-types.js";

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

function assertJsonEqual(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
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
// Section A fakes (real service, fake runtime)
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

const PARENT_RUNTIME: SubagentParentRuntimeSnapshot = {
  model: makeModel("parent-model", "faux"),
  thinkingLevel: "xhigh",
  executionMode: "approval",
  verificationGate: false,
};

interface FakeTimerEntry {
  callback: () => void;
  ms: number;
  cancelled: boolean;
}

function makeFakeTimers(baseNow: number): {
  now: () => number;
  setTimer: (callback: () => void, ms: number) => { cancel: () => void };
  timers: () => FakeTimerEntry[];
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
  };
}

class FakeRuntime {
  static instances: FakeRuntime[] = [];

  readonly spec: AgentTaskSpec;
  input: AgentTaskInputRouter | undefined;
  abortCalls = 0;
  disposeCalls = 0;
  private _resolveRun: ((result: unknown) => void) | undefined;
  settled = false;

  constructor(spec: AgentTaskSpec) {
    this.spec = spec;
    FakeRuntime.instances.push(this);
  }

  run(): Promise<unknown> {
    return new Promise<unknown>((resolve) => {
      this._resolveRun = resolve;
    });
  }

  /** Settles the run like a real completed runtime (optional per-result overrides). */
  complete(overrides?: { structured?: unknown }): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    const results = this.spec.items.map((item, index) => ({
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
      ...(overrides?.structured !== undefined ? { structured: overrides.structured } : {}),
    }));
    this._resolveRun?.({ status: "completed", finalOutput: `final-${this.spec.taskId}`, results, usage: emptyUsage(), activities: [] });
  }

  /** Settles like a schema child that ran but never called submit_workflow_result. */
  failMissingStructured(): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this._resolveRun?.({
      status: "failed",
      failureReason: "invalid_parameters",
      finalOutput: "",
      results: this.spec.items.map((item, index) => ({
        id: `fake-${this.spec.taskId}-${index}`,
        index: item.index,
        agentName: item.resolution === "ready" ? item.agent.name : item.requestedAgentName ?? "general-purpose",
        agentSource: item.resolution === "ready" ? item.agent.source : "unknown",
        description: item.description,
        status: "failed",
        failureReason: "invalid_parameters",
        errorMessage: "The workflow child did not submit the structured result (missing submit_workflow_result tool call).",
        finalOutput: "",
        outputTruncated: false,
        originalOutputBytes: 0,
        toolUseCount: 0,
        activities: [],
        usage: emptyUsage(),
        startedAt: 1000,
        endedAt: 2000,
        durationMs: 1000,
      })),
      usage: emptyUsage(),
      activities: [],
    });
  }

  abort(): void {
    this.abortCalls++;
    if (!this.settled) {
      this.settled = true;
      // A real runtime settles as cancelled with a bounded result; finalOutput
      // is part of the persisted info, so the state event must carry it.
      this._resolveRun?.({
        status: "cancelled",
        finalOutput: `final-${this.spec.taskId}`,
        results: this.spec.items.map((item, index) => ({
          id: `fake-${this.spec.taskId}-${index}`,
          index: item.index,
          agentName: item.resolution === "ready" ? item.agent.name : item.requestedAgentName ?? "general-purpose",
          agentSource: item.resolution === "ready" ? item.agent.source : "unknown",
          description: item.description,
          status: "aborted",
          failureReason: "aborted",
          errorMessage: "The agent task was aborted.",
          finalOutput: "",
          outputTruncated: false,
          originalOutputBytes: 0,
          toolUseCount: 0,
          activities: [],
          usage: emptyUsage(),
          endedAt: 3000,
          durationMs: 2000,
        })),
        usage: emptyUsage(),
        activities: [],
      });
    }
  }

  dispose(): Promise<void> {
    this.disposeCalls++;
    return Promise.resolve();
  }
}

class FakeCollector {
  readonly records: ProductEvent[] = [];
  record(event: ProductEvent): void {
    if (isProductEvent(event)) {
      this.records.push(event);
    }
  }
}

interface Harness {
  service: AgentTaskService;
  store: AgentTaskStore;
  resolveHostDisposed: () => void;
  hostDisposed: Promise<"host_disposed">;
}

function makeHarness(extraHooks?: Partial<AgentTaskServiceTestHooks>): Harness {
  FakeRuntime.instances = [];
  const cwd = mkdtempSync(join(tmpdir(), "pix-workflow-spawner-"));
  const events = new FakeCollector() as never;
  let resolveHostDisposed: () => void = () => {};
  const hostDisposed = new Promise<"host_disposed">((resolve) => {
    resolveHostDisposed = () => resolve("host_disposed");
  });
  const store = new AgentTaskStore({
    rootDir: mkdtempSync(join(tmpdir(), "pix-workflow-spawner-store-")),
    maxTaskBytes: 25 * 1024 * 1024,
    maxWorkspaceBytes: 500 * 1024 * 1024,
  });
  const service = new AgentTaskService({
    settings: { cwd } as never,
    events,
    store,
    runId: "test-run-1",
  });
  __setAgentTaskServiceHooksForTests({
    autoBackgroundMsOverride: 0,
    runtimeFactory: (spec) => new FakeRuntime(spec) as never,
    ...extraHooks,
  });
  return { service, store, resolveHostDisposed, hostDisposed };
}

function makeContext(harness: Harness, overrides?: Partial<AgentTaskSubmissionContext>): AgentTaskSubmissionContext {
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
    agentDir: join(tmpdir(), "pix-workflow-spawner-agent"),
    loadedAgents: loaded,
    modelRegistry: {
      getAll: () => [makeModel("alpha", "faux"), makeModel("beta", "faux")],
      find: (provider: string, modelId: string) =>
        provider === "faux" && (modelId === "alpha" || modelId === "beta") ? makeModel(modelId, "faux") : undefined,
      hasConfiguredAuth: () => true,
    } as never,
    parentRuntime: { ...PARENT_RUNTIME },
    requestUserInput: (): Promise<RequestUserInputResponse> => Promise.resolve({ id: "req", answers: {}, cancelled: false }),
    hostDisposed: harness.hostDisposed,
    ...overrides,
  };
}

function makeParent(harness: Harness): WorkflowParentRef {
  return {
    sessionId: "session-1",
    toolCallId: "tool-call-1",
    getSubmissionContext: () => makeContext(harness),
  };
}

function makeRequest(overrides: Partial<ChildStartRequest> = {}): ChildStartRequest {
  return { prompt: "Do the workflow child task", ...overrides };
}

/** Fill all 4 global slots with never-settling tasks; returns their taskIds. */
async function occupyAllSlots(harness: Harness, context: AgentTaskSubmissionContext): Promise<string[]> {
  const taskIds: string[] = [];
  for (let i = 0; i < 4; i++) {
    const params: CreateTaskParams = {
      mode: "single",
      agentScope: "user",
      tasks: [{ prompt: `filler ${i}`, description: `filler ${i}` }],
      runInBackground: false,
    };
    const handle = await harness.service.createTaskGroup(params, context, "foreground");
    taskIds.push(handle.tasks[0].taskId);
  }
  return taskIds;
}

// ============================================================================
// Section A: provider mapping
// ============================================================================

await run("resolveWorkflowAgentType provider mapping (locked)", async () => {
  assertEqual(resolveWorkflowAgentType(undefined, undefined).agentType, "general-purpose", "missing -> general-purpose");
  assertEqual(resolveWorkflowAgentType("ralph-default", undefined).agentType, "ralph-default", "missing -> runDefault");
  assertEqual(resolveWorkflowAgentType(undefined, "spawn").agentType, "general-purpose", "\"spawn\" alias -> general-purpose");
  assertEqual(resolveWorkflowAgentType("ralph-default", "spawn").agentType, "ralph-default", "\"spawn\" alias -> runDefault");
  assertEqual(resolveWorkflowAgentType(undefined, "scout").agentType, "scout", "other name used as subagent_type");
  assertEqual(
    resolveWorkflowAgentType(undefined, "  scout  ").agentType,
    "scout",
    "other name trimmed before use",
  );

  const fork = resolveWorkflowAgentType(undefined, "fork");
  assert(fork.error instanceof WorkflowError && fork.error.code === "UNSUPPORTED_OPTION", "\"fork\" is UNSUPPORTED_OPTION");
  assert(resolveWorkflowAgentType("x", "fork").error?.code === "UNSUPPORTED_OPTION", "\"fork\" wins over runDefault");
  assert(resolveWorkflowAgentType(undefined, "").error?.code === "INVALID_ARGUMENT", "empty provider is INVALID_ARGUMENT");
  assert(
    resolveWorkflowAgentType(undefined, "   ").error?.code === "INVALID_ARGUMENT",
    "whitespace-only provider is INVALID_ARGUMENT",
  );
});

await run("spawner: \"fork\" provider fails before createTaskGroup", async () => {
  const harness = makeHarness();
  const spawner = createAgentTaskChildSpawner(harness.service);
  let caught: unknown;
  try {
    await spawner.start(makeRequest({ provider: "fork" }), makeParent(harness), new AbortController().signal);
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof WorkflowError && caught.code === "UNSUPPORTED_OPTION", "fork start throws UNSUPPORTED_OPTION");
  assertEqual(FakeRuntime.instances.length, 0, "no task group was created");
  await harness.service.dispose("user_cancel");
});

// ============================================================================
// Section A: ChildResult projection
// ============================================================================

await run("spawner: completed child without schema resolves text + completed", async () => {
  const harness = makeHarness();
  const spawner = createAgentTaskChildSpawner(harness.service);
  const child = await spawner.start(makeRequest(), makeParent(harness), new AbortController().signal);

  const runtime = FakeRuntime.instances.find((instance) => instance.spec.taskId === child.id);
  assert(runtime !== undefined, "the spawner's task registered a runtime");
  runtime!.complete();

  const result = await child.result;
  assertEqual(result.stopReason, "completed", "stopReason completed");
  assertEqual(result.output.length, 1, "one text block");
  assertEqual(result.output[0].text, "output-0", "output carries the child final output");
  assert(result.structured === undefined, "no structured field without schema");
  await harness.service.dispose("user_cancel");
});

await run("spawner: completed schema child projects the capture-validated structured object", async () => {
  const harness = makeHarness();
  const spawner = createAgentTaskChildSpawner(harness.service);
  const schema = { type: "object", properties: { answer: { type: "object" } }, required: ["answer"] };
  const child = await spawner.start(
    makeRequest({ schema }),
    makeParent(harness),
    new AbortController().signal,
  );

  const runtime = FakeRuntime.instances.find((instance) => instance.spec.taskId === child.id);
  runtime!.complete({ structured: { answer: { value: 42 } } });

  const result = await child.result;
  assertEqual(result.stopReason, "completed", "stopReason completed");
  assertJsonEqual(result.structured, { answer: { value: 42 } }, "structured is the capture-validated object");
  assertEqual(result.output.length, 1, "one text block");
  assertEqual(result.output[0].text, JSON.stringify({ answer: { value: 42 } }), "output is the JSON projection");
  await harness.service.dispose("user_cancel");
});

await run("spawner: schema child that never submits resolves failed (script null, never AGENT_START)", async () => {
  const harness = makeHarness();
  const spawner = createAgentTaskChildSpawner(harness.service);
  const schema = { type: "object", properties: { answer: { type: "object" } }, required: ["answer"] };
  const child = await spawner.start(
    makeRequest({ schema, label: "Ralph round 1" }),
    makeParent(harness),
    new AbortController().signal,
  );
  const runtime = FakeRuntime.instances.find((instance) => instance.spec.taskId === child.id);
  assertEqual(runtime!.spec.items[0].description, "Ralph round 1", "explicit label reaches the task description");
  runtime!.failMissingStructured();
  const result = await child.result;
  assertEqual(result.stopReason, "failed", "missing structured submit resolves as a child failure");
  assertEqual(result.failureReason, "invalid_parameters", "failureReason is projected");
  assert(
    (result.error ?? "").includes("structured"),
    "error message is projected from the nested result",
  );
  await harness.service.dispose("user_cancel");
});

await run("spawner: runDefault (providerDefault) maps the subagent_type", async () => {
  const harness = makeHarness();
  const spawner = createAgentTaskChildSpawner(harness.service);
  const child = await spawner.start(
    makeRequest({ providerDefault: "user-helper" }),
    makeParent(harness),
    new AbortController().signal,
  );
  const runtime = FakeRuntime.instances.find((instance) => instance.spec.taskId === child.id);
  const item = runtime!.spec.items[0];
  assert(item.resolution === "ready", "item is ready");
  if (item.resolution === "ready") {
    assertEqual(item.agent.name, "user-helper", "providerDefault became the agent type");
  }
  runtime!.complete();
  const result = await child.result;
  assertEqual(result.stopReason, "completed", "child completed");
  await harness.service.dispose("user_cancel");
});

await run("spawner: request.maxTurns overrides the nested item cap", async () => {
  const harness = makeHarness();
  const spawner = createAgentTaskChildSpawner(harness.service);
  const schema = { type: "object", properties: { answer: { type: "object" } }, required: ["answer"] };
  const child = await spawner.start(
    makeRequest({ schema, maxTurns: 8 }),
    makeParent(harness),
    new AbortController().signal,
  );
  const runtime = FakeRuntime.instances.find((instance) => instance.spec.taskId === child.id);
  const item = runtime!.spec.items[0];
  assert(item.resolution === "ready", "item is ready");
  if (item.resolution === "ready") {
    assertEqual(item.maxTurns, 8, "extras.maxTurns became the item cap");
  }
  runtime!.complete({ structured: { answer: {} } });
  await child.result;
  await harness.service.dispose("user_cancel");
});

await run("spawner: preflight rejection rejects the handle (child-failed, never a script null)", async () => {
  const harness = makeHarness();
  const spawner = createAgentTaskChildSpawner(harness.service);
  // An unknown provider maps to a subagent_type that does not exist.
  const child = await spawner.start(
    makeRequest({ provider: "no-such-agent" }),
    makeParent(harness),
    new AbortController().signal,
  );
  let rejected: unknown;
  try {
    await child.result;
  } catch (error) {
    rejected = error;
  }
  assert(rejected instanceof WorkflowError, "preflight rejection rejects the handle");
  assert(rejected instanceof WorkflowError && rejected.message.includes("no-such-agent"), "message names the agent");
  assert(
    rejected instanceof WorkflowError && rejected.message.includes("Known user-scope agents"),
    "message lists known agent definition names",
  );
  await harness.service.dispose("user_cancel");
});

await run("spawner: illegal modelOverride rejects the handle (AGENT_START path)", async () => {
  const harness = makeHarness();
  const spawner = createAgentTaskChildSpawner(harness.service);
  // The modelOverride closure runs through preflight: provider/id pair that
  // the borrowed registry cannot resolve fails the item as rejected.
  const child = await spawner.start(
    makeRequest({ model: "faux/nope" }),
    makeParent(harness),
    new AbortController().signal,
  );
  let rejected: unknown;
  try {
    await child.result;
  } catch (error) {
    rejected = error;
  }
  assert(rejected instanceof WorkflowError, "illegal model rejects the handle");
  assert(rejected instanceof WorkflowError && rejected.message.includes("faux/nope"), "message names the model");
  await harness.service.dispose("user_cancel");
});

await run("spawner: modelOverride resolves into the frozen ready item", async () => {
  const harness = makeHarness();
  const spawner = createAgentTaskChildSpawner(harness.service);
  const schema = { type: "object" };
  const child = await spawner.start(
    makeRequest({ model: "faux/alpha", schema }),
    makeParent(harness),
    new AbortController().signal,
  );
  const runtime = FakeRuntime.instances.find((instance) => instance.spec.taskId === child.id);
  const item = runtime!.spec.items[0];
  assert(item.resolution === "ready", "item is ready");
  if (item.resolution === "ready") {
    assertEqual(item.model.provider, "faux", "modelOverride provider resolved");
    assertEqual(item.model.modelId, "alpha", "modelOverride id resolved (takes precedence over inherit)");
    assertJsonEqual(item.outputSchema, schema, "outputSchema frozen into the ready item");
  }
  runtime!.complete({ structured: { done: true } });
  const result = await child.result;
  assertEqual(result.stopReason, "completed", "child completed");
  await harness.service.dispose("user_cancel");
});

await run("spawner: queued child cancelled resolves null (never AGENT_START)", async () => {
  const harness = makeHarness();
  const context = makeContext(harness);
  const fillerTaskIds = await occupyAllSlots(harness, context);
  const spawner = createAgentTaskChildSpawner(harness.service);
  const child = await spawner.start(makeRequest(), makeParent(harness), new AbortController().signal);
  assert(fillerTaskIds.includes(child.id) === false, "the spawner child is a distinct task");

  // All 4 slots are held by never-settling fillers, so the child is queued;
  // a queued cancel must project as a RESOLVED cancelled result (script null).
  const cancelOutcome = await harness.service.cancel(child.id, 0, "user_cancel");
  assertEqual(cancelOutcome.ok, true, "queued cancel accepted");
  const result = await child.result;
  assertEqual(result.stopReason, "cancelled", "queued cancel resolves with stopReason cancelled (not a rejection)");
  await harness.service.dispose("user_cancel");
});

await run("spawner: backgrounded child rejects and dispose cancels by taskId even after detach", async () => {
  const harness = makeHarness();
  const spawner = createAgentTaskChildSpawner(harness.service);
  const child = await spawner.start(makeRequest(), makeParent(harness), new AbortController().signal);

  // A session-close detach is the only background path left for workflow
  // children; the locked mapping turns it into a rejection.
  harness.service.detachForegroundGroupsForSession("session-1");
  let rejected: unknown;
  try {
    await child.result;
  } catch (error) {
    rejected = error;
  }
  assert(rejected instanceof WorkflowError, "backgrounded child rejects");
  assertEqual(
    rejected instanceof WorkflowError ? rejected.message : "",
    "workflow child was detached",
    "rejection text is the locked wording",
  );

  // dispose/reap still cancels by taskId, even though the race already
  // detached the group (cancelGroup would be a no-op here).
  const runtime = FakeRuntime.instances.find((instance) => instance.spec.taskId === child.id);
  await child.dispose();
  await waitFor(() => runtime!.abortCalls > 0, 20000, "dispose cancelled the detached child by taskId");
  const snapshot = harness.service.getAll();
  const info = snapshot.tasks.find((task: AgentTaskInfo) => task.taskId === child.id);
  assertEqual(info?.status, "cancelled", "the detached child reached the terminal cancelled state");
  await harness.service.dispose("user_cancel");
});

// ============================================================================
// Section A: workflowOwned group protections
// ============================================================================

await run("workflowOwned: background() refuses with workflow_owned", async () => {
  const harness = makeHarness();
  const spawner = createAgentTaskChildSpawner(harness.service);
  const child = await spawner.start(makeRequest(), makeParent(harness), new AbortController().signal);

  const outcome = harness.service.background(child.id, 0);
  assertEqual(outcome.ok, false, "background() on a workflowOwned group fails");
  assertEqual(outcome.reason, "workflow_owned", "failure reason is workflow_owned");
  await child.dispose();
  await harness.service.dispose("user_cancel");
});

await run("workflowOwned: auto-background timer is never started", async () => {
  const baseNow = 1_770_000_000_000;
  const fakeTimers = makeFakeTimers(baseNow);
  const harness = makeHarness({
    autoBackgroundMsOverride: 60_000,
    now: fakeTimers.now,
    setTimer: fakeTimers.setTimer,
  });
  const spawner = createAgentTaskChildSpawner(harness.service);

  const child = await spawner.start(makeRequest(), makeParent(harness), new AbortController().signal);
  assertEqual(fakeTimers.timers().length, 0, "no auto-background timer for a workflow child");

  // Baseline: a plain foreground group still arms the warning + deadline timers.
  const context = makeContext(harness);
  const params: CreateTaskParams = {
    mode: "single",
    agentScope: "user",
    tasks: [{ prompt: "baseline", description: "baseline" }],
    runInBackground: false,
  };
  await harness.service.createTaskGroup(params, context, "foreground");
  assertEqual(fakeTimers.timers().length, 2, "baseline foreground group arms the auto-background timers");

  await child.dispose();
  await harness.service.dispose("user_cancel");
});

await run("workflowOwned: ready item carries outputSchema; workflowExtras written", async () => {
  const harness = makeHarness();
  const spawner = createAgentTaskChildSpawner(harness.service);
  const schema = { type: "object", required: ["done"] };
  const child = await spawner.start(
    makeRequest({ schema, provider: "user-helper" }),
    makeParent(harness),
    new AbortController().signal,
  );
  const runtime = FakeRuntime.instances.find((instance) => instance.spec.taskId === child.id);
  assertEqual(runtime!.spec.groupMode, "single", "spawn params: single mode");
  assertEqual(runtime!.spec.mode, "single", "spawn params: single runtime mode");
  assertEqual(runtime!.spec.agentScope, "user", "spawn params: agentScope user (never both)");
  assertEqual(runtime!.spec.items[0].resolution, "ready", "item ready");
  if (runtime!.spec.items[0].resolution === "ready") {
    assertEqual(runtime!.spec.items[0].agent.name, "user-helper", "provider maps to the agent definition");
    assertJsonEqual(runtime!.spec.items[0].outputSchema, schema, "outputSchema frozen into the ready item");
  }
  runtime!.complete({ structured: { done: true } });
  const result = await child.result;
  assertEqual(result.stopReason, "completed", "child completed");
  await harness.service.dispose("user_cancel");
});

// ============================================================================
// Section B: real AgentTaskRuntime schema children (faux provider)
// ============================================================================

const AGENT_DIR = mkdtempSync(join(tmpdir(), "pix-workflow-runtime-agent-"));
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
const PROJECT_CWD = mkdtempSync(join(tmpdir(), "pix-workflow-runtime-project-"));

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
          headers: { "X-Faux": "abc" },
        },
      ],
    },
  },
};
mkdirSync(AGENT_DIR, { recursive: true });
writeFileSync(join(AGENT_DIR, "models.json"), JSON.stringify(MODELS_JSON, null, 2), "utf-8");

const HARNESS_AUTH = AuthStorage.create(join(AGENT_DIR, "auth.json"));
const HARNESS_REGISTRY = ModelRegistry.create(HARNESS_AUTH, join(AGENT_DIR, "models.json"));

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
  scripts: [] as StreamScript[],
};

function fauxStream(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  if (options?.signal?.aborted) {
    const aborted = makeAssistantMessage(model, { stopReason: "aborted" });
    stream.push({ type: "error", reason: "aborted", error: aborted });
    stream.end(aborted);
    return stream;
  }
  const script = provider.scripts.shift() ?? { kind: "message", text: "", stopReason: "stop" };
  if (script.kind === "hang") {
    const onAbort = (): void => {
      const aborted = makeAssistantMessage(model, { text: script.abortText, stopReason: "aborted" });
      stream.push({ type: "error", reason: "aborted", error: aborted });
      stream.end(aborted);
    };
    options?.signal?.addEventListener("abort", onAbort, { once: true });
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

let taskCounter = 0;

function makeLocation(): ProjectLocation {
  return {
    path: PROJECT_CWD,
    physicalPath: PROJECT_CWD,
    name: "workflow-runtime",
    environment: { kind: "windows" },
  };
}

function makeSpec(items: AgentTaskSpec["items"]): AgentTaskSpec {
  taskCounter++;
  const location = makeLocation();
  return {
    schemaVersion: 1,
    taskId: `wf-task-${taskCounter}`,
    groupId: `wf-group-${taskCounter}`,
    groupMode: "single",
    mode: "single",
    items,
    agentScope: "user",
    thinkingLevel: "high",
    executionMode: "approval",
    verificationGate: true,
    project: location,
    workspaceId: workspaceIdOf(location.physicalPath),
    agentDir: AGENT_DIR,
    parentSessionId: "parent-session",
    parentToolCallId: "parent-tool-call",
    createdAt: Date.now(),
  };
}

const REPORT_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "object" },
    answer: { type: "object" },
  },
  required: ["status"],
  additionalProperties: false,
};

type ReadyItem = Extract<AgentTaskSpec["items"][number], { resolution: "ready" }>;

function makeReadyItem(overrides: Partial<ReadyItem> = {}): ReadyItem {
  return {
    resolution: "ready",
    index: 0,
    prompt: "do the thing",
    description: "A workflow runtime item",
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

interface MockInputRouter {
  enqueue(taskId: string, generation: number, request: RequestUserInputRequest, signal: AbortSignal): void;
  respond(taskId: string, requestId: string, generation: number, response: RequestUserInputResponse): boolean;
  cancel(taskId: string, requestId: string, generation: number): boolean;
  settleOnShutdown(): void;
}

function makeInputMock(): AgentTaskInputRouter {
  const router: MockInputRouter = {
    enqueue: () => {},
    respond: () => true,
    cancel: () => true,
    settleOnShutdown: () => {},
  };
  return router as unknown as AgentTaskInputRouter;
}

function submitCall(args: Record<string, unknown>, id = "submit-1"): StreamScript {
  return { kind: "message", text: "", stopReason: "stop", toolCall: { name: "submit_workflow_result", id, args } };
}

const SCHEMA_CHILD_SCHEMA = {
  type: "object",
  properties: { answer: { type: "object" } },
  required: ["answer"],
  additionalProperties: false,
};

await run("runtime: no-schema item behaves exactly as today (baseline)", async () => {
  provider.scripts.length = 0;
  provider.scripts.push({ kind: "message", text: "plain result", stopReason: "stop" });
  const runtime = new AgentTaskRuntime({ spec: makeSpec([makeReadyItem()]), input: makeInputMock() });
  const result = await runtime.run(new AbortController().signal, () => {});
  assertEqual(result.status, "completed", "no-schema item completes");
  assertEqual(result.results[0].status, "completed", "result completed");
  assertEqual(result.results[0].finalOutput, "plain result", "final output is the terminal text");
  assert(result.results[0].structured === undefined, "structured never appears on the no-schema path");
  await runtime.dispose();
});

await run("runtime: schema child that never submits fails with invalid_parameters", async () => {
  provider.scripts.length = 0;
  provider.scripts.push({ kind: "message", text: "work done, no submit", stopReason: "stop" });
  const item = makeReadyItem({ outputSchema: SCHEMA_CHILD_SCHEMA });
  const runtime = new AgentTaskRuntime({ spec: makeSpec([item]), input: makeInputMock() });
  const result = await runtime.run(new AbortController().signal, () => {});
  assertEqual(result.status, "failed", "never-submitting schema child fails");
  assertEqual(result.failureReason, "invalid_parameters", "failureReason is invalid_parameters");
  assertIncludes(result.results[0].errorMessage ?? "", "structured", "message states the missing structured submit");
  assert(result.results[0].startedAt !== undefined, "startedAt is written after the item actually ran");
  await runtime.dispose();
});

await run("runtime: schema child submits a valid value -> completed with structured", async () => {
  provider.scripts.length = 0;
  provider.scripts.push(submitCall({ answer: { value: 42 } }));
  const item = makeReadyItem({ outputSchema: SCHEMA_CHILD_SCHEMA, agent: { ...makeReadyItem().agent, tools: ["read", "bash"] } });
  const runtime = new AgentTaskRuntime({ spec: makeSpec([item]), input: makeInputMock() });
  const result = await runtime.run(new AbortController().signal, () => {});
  assertEqual(result.status, "completed", "schema child with a valid submit completes");
  assertEqual(result.results[0].status, "completed", "result completed");
  assertJsonEqual(result.results[0].structured, { answer: { value: 42 } }, "structured readable at results[0]");
  assertEqual(result.results[0].finalOutput, JSON.stringify({ answer: { value: 42 } }), "finalOutput is the JSON projection");
  await runtime.dispose();
});

await run("runtime: a valid submit completes even if later turns would hit max_turns", async () => {
  provider.scripts.length = 0;
  provider.scripts.push(submitCall({ answer: { value: 1 } }));
  provider.scripts.push({
    kind: "message",
    text: "keep going",
    stopReason: "stop",
    toolCall: { name: "read", id: "tc-extra", args: { path: "x.txt" } },
  });
  provider.scripts.push({ kind: "message", text: "still going", stopReason: "stop" });
  const item = makeReadyItem({ outputSchema: SCHEMA_CHILD_SCHEMA, maxTurns: 2 });
  const runtime = new AgentTaskRuntime({ spec: makeSpec([item]), input: makeInputMock() });
  const result = await runtime.run(new AbortController().signal, () => {});
  assertEqual(result.status, "completed", "captured structured wins over a later max_turns");
  assertJsonEqual(result.results[0].structured, { answer: { value: 1 } }, "structured is the submitted value");
  await runtime.dispose();
});

await run("runtime: schema child retries after an invalid submit", async () => {
  provider.scripts.length = 0;
  provider.scripts.push(submitCall({ bad: true }, "submit-1"));
  provider.scripts.push(submitCall({ answer: { value: 7 } }, "submit-2"));
  const item = makeReadyItem({ outputSchema: SCHEMA_CHILD_SCHEMA });
  const runtime = new AgentTaskRuntime({ spec: makeSpec([item]), input: makeInputMock() });
  const result = await runtime.run(new AbortController().signal, () => {});
  assertEqual(result.status, "completed", "retry after an invalid submit completes");
  assertJsonEqual(result.results[0].structured, { answer: { value: 7 } }, "structured is the retried value");
  await runtime.dispose();
});

await run("runtime: invalid submit then stop -> failed (structured still missing)", async () => {
  provider.scripts.length = 0;
  provider.scripts.push(submitCall({ bad: true }, "submit-1"));
  provider.scripts.push({ kind: "message", text: "giving up", stopReason: "stop" });
  const item = makeReadyItem({ outputSchema: SCHEMA_CHILD_SCHEMA });
  const runtime = new AgentTaskRuntime({ spec: makeSpec([item]), input: makeInputMock() });
  const result = await runtime.run(new AbortController().signal, () => {});
  assertEqual(result.status, "failed", "invalid submit without a retry fails");
  assertEqual(result.failureReason, "invalid_parameters", "failureReason is invalid_parameters");
  assert(result.results[0].structured === undefined, "no structured recorded for the failed submit");
  await runtime.dispose();
});

await run("runtime: tools allowlist is merged with submit_workflow_result", async () => {
  provider.scripts.length = 0;
  provider.scripts.push(submitCall({ answer: { value: 1 } }));
  // The whitelist ["read","bash"] would hide the custom tool without the
  // locked merge; a completed run proves the tool was callable.
  const item = makeReadyItem({
    outputSchema: SCHEMA_CHILD_SCHEMA,
    agent: { ...makeReadyItem().agent, tools: ["read", "bash"] },
  });
  const runtime = new AgentTaskRuntime({ spec: makeSpec([item]), input: makeInputMock() });
  const result = await runtime.run(new AbortController().signal, () => {});
  assertEqual(result.status, "completed", "submit_workflow_result callable under a tools allowlist");
  assertJsonEqual(result.results[0].structured, { answer: { value: 1 } }, "structured captured under the allowlist");
  await runtime.dispose();
});

await run("runtime: capture tool validates the submitted value against the schema", async () => {
  provider.scripts.length = 0;
  // additionalProperties: false + required ["answer"]: an empty submit fails
  // the capture instance validation and must NOT terminate the child.
  provider.scripts.push(submitCall({}, "submit-1"));
  provider.scripts.push({ kind: "message", text: "stopped", stopReason: "stop" });
  const item = makeReadyItem({ outputSchema: SCHEMA_CHILD_SCHEMA });
  const runtime = new AgentTaskRuntime({ spec: makeSpec([item]), input: makeInputMock() });
  const result = await runtime.run(new AbortController().signal, () => {});
  assertEqual(result.status, "failed", "schema-invalid submit does not complete the child");
  assertEqual(result.failureReason, "invalid_parameters", "failureReason is invalid_parameters");
  await runtime.dispose();
});

await run("runtime: schema child submit is validated against REPORT_SCHEMA semantics", async () => {
  provider.scripts.length = 0;
  // REPORT_SCHEMA requires status and forbids extras; an unknown key fails.
  provider.scripts.push(submitCall({ status: { done: true }, extra: 1 }, "submit-1"));
  provider.scripts.push(submitCall({ status: { done: true } }, "submit-2"));
  const item = makeReadyItem({ outputSchema: REPORT_SCHEMA });
  const runtime = new AgentTaskRuntime({ spec: makeSpec([item]), input: makeInputMock() });
  const result = await runtime.run(new AbortController().signal, () => {});
  assertEqual(result.status, "completed", "retried report-shaped submit completes");
  assertJsonEqual(result.results[0].structured, { status: { done: true } }, "structured is the validated report");
  await runtime.dispose();
});

await run("runtime: schema child gets a last-turn submit nudge and can still complete", async () => {
  provider.scripts.length = 0;
  provider.scripts.push({ kind: "message", text: "prose, no submit", stopReason: "stop" });
  provider.scripts.push(submitCall({ answer: { value: 9 } }, "submit-nudge"));
  const item = makeReadyItem({ outputSchema: SCHEMA_CHILD_SCHEMA, maxTurns: 2 });
  const runtime = new AgentTaskRuntime({ spec: makeSpec([item]), input: makeInputMock() });
  const result = await runtime.run(new AbortController().signal, () => {});
  assertEqual(result.status, "completed", "nudge turn submitted structured output");
  assertJsonEqual(result.results[0].structured, { answer: { value: 9 } }, "structured is the nudged submit");
  await runtime.dispose();
});

await run("runtime: schema child that stops early is recovered by an in-session submit prompt", async () => {
  provider.scripts.length = 0;
  provider.scripts.push({ kind: "message", text: "I'll write a summary instead", stopReason: "stop" });
  provider.scripts.push(submitCall({ answer: { value: 4 } }, "submit-recover"));
  const item = makeReadyItem({ outputSchema: SCHEMA_CHILD_SCHEMA, maxTurns: 12 });
  const runtime = new AgentTaskRuntime({ spec: makeSpec([item]), input: makeInputMock() });
  const result = await runtime.run(new AbortController().signal, () => {});
  assertEqual(result.status, "completed", "early-stop recovery submitted structured output");
  assertJsonEqual(result.results[0].structured, { answer: { value: 4 } }, "structured is the recovered submit");
  await runtime.dispose();
});

await run("runtime: schema-valid JSON in the child's text is salvaged without a submit tool call", async () => {
  provider.scripts.length = 0;
  provider.scripts.push({
    kind: "message",
    text: "done\n```json\n{\"answer\":{\"value\":11}}\n```",
    stopReason: "stop",
  });
  const item = makeReadyItem({ outputSchema: SCHEMA_CHILD_SCHEMA, maxTurns: 12 });
  const runtime = new AgentTaskRuntime({ spec: makeSpec([item]), input: makeInputMock() });
  const result = await runtime.run(new AbortController().signal, () => {});
  assertEqual(result.status, "completed", "salvaged JSON completes the schema child");
  assertJsonEqual(result.results[0].structured, { answer: { value: 11 } }, "structured is the salvaged object");
  await runtime.dispose();
});

// ============================================================================
// Cleanup: remove the temp agent/project dirs
// ============================================================================

try {
  rmSync(AGENT_DIR, { recursive: true, force: true });
} catch {
  // Best-effort cleanup on Windows (open handles may defer deletion).
}
try {
  rmSync(PROJECT_CWD, { recursive: true, force: true });
} catch {
  // Best-effort cleanup on Windows (open handles may defer deletion).
}

// ============================================================================

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
