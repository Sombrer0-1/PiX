/**
 * SubagentRunner facade + `agent` tool tests (S2, PiX 1.4.1 B4).
 *
 * The runner is now a thin service facade: it synchronously assembles the
 * AgentTaskSubmissionContext and delegates to the app-level AgentTaskService
 * (createTaskGroup/awaitGroup). Most tests drive the facade against a REAL
 * AgentTaskService whose runtime factory is replaced by a controllable fake
 * (__setAgentTaskServiceHooksForTests), so preflight, foreground completion,
 * usage ownership, progress rebuild, parent-signal cancellation, dispose
 * classification, direct/auto/manual background and the group-handle contract
 * are all exercised without nested sessions.
 *
 * The WSL Shell tool isolation tests drive the REAL AgentTaskRuntime through
 * the facade+service with an injected fake WSL execution context
 * (__setAgentTaskRuntimeContextFactoriesForTests): explicit shell-background
 * tools fail as tool_unavailable before any session, the all-tools activation
 * path can never re-add them, and Windows runtimes keep them available.
 *
 * The `agent` tool tests assert the 1.4.1 contract: run_in_background defaults
 * to false, the description forbids self-selecting the background, foreground
 * returns the existing SubagentDetails and a backgrounded group returns a
 * group handle.
 *
 * Run with: npx tsx src/main/__tests__/subagent-runner.test.ts
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, AssistantMessageEventStream, Context, Model, SimpleStreamOptions, Usage } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, type Api } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  AgentSession,
  AuthStorage,
  ModelRegistry,
  type AgentExecutionMode,
  type ExecutionBackend,
  type FileChangeSummary,
  type LoadAgentsResult,
  type RequestUserInputRequest,
  type RequestUserInputResponse,
  type TurnDiffSummary,
} from "@earendil-works/pi-coding-agent";
import { isSubagentDetails } from "../../shared/subagent-types.js";
import type { SubagentDetails, SubagentUsage } from "../../shared/subagent-types.js";
import type { ProjectLocation } from "../../shared/project-location.js";
import type { AgentTaskActivity, AgentTaskGroupHandle, AgentTaskSpec } from "../../shared/agent-task-types.js";
import { SettingsStore } from "../settings-store.js";
import { isProductEvent, type ProductEvent } from "../../shared/product-events.js";
import type { ProductEventCollector } from "../product-event-collector.js";
import type { AgentTaskInputRouter } from "../agent-task/agent-task-input.js";
import type { AgentTaskRuntime, AgentTaskRuntimeResult } from "../agent-task/agent-task-runtime.js";
import {
  AgentTaskService,
  __setAgentTaskServiceHooksForTests,
  type AgentTaskServiceTestHooks,
  type AgentTaskSubmissionContext,
} from "../agent-task/agent-task-service.js";
import { __setAgentTaskRuntimeContextFactoriesForTests } from "../agent-task/agent-task-runtime.js";
import { AgentTaskStore } from "../agent-task/agent-task-store.js";
import { disposeProjectExecutionContext } from "../execution-context.js";
import {
  MAX_DELEGATED_PROMPT_BYTES,
  MAX_PARALLEL_TASKS,
  SHELL_BACKGROUND_TOOLS,
  SubagentRunner,
  type SubagentRunOptions,
} from "../subagent/subagent-runner.js";
import { createSubagentToolDefinition, SUBAGENT_TOOL_NAME } from "../subagent/subagent-tool.js";
import type { SubagentExecutionContext, SubagentToolHost } from "../subagent/types.js";

// ============================================================================
// Test harness (matches the pre-migration style)
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

/** Poll without relying on Date.now (which the fake clock freezes). */
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
// Shared temp environment (agentDir + project cwd)
// ============================================================================

const AGENT_DIR = mkdtempSync(join(tmpdir(), "pix-subagent-agent-"));
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
const AGENTS_DIR = join(AGENT_DIR, "agents");
mkdirSync(AGENTS_DIR, { recursive: true });
const PROJECT_CWD = mkdtempSync(join(tmpdir(), "pix-subagent-project-"));

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
        {
          id: "x/y",
          name: "Slash Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 100000,
          maxTokens: 4096,
        },
      ],
    },
  },
};

function writeModelsJson(): void {
  writeFileSync(join(AGENT_DIR, "models.json"), JSON.stringify(MODELS_JSON, null, 2), "utf-8");
}

writeModelsJson();

function clearAgents(): void {
  rmSync(AGENTS_DIR, { recursive: true, force: true });
  mkdirSync(AGENTS_DIR, { recursive: true });
  rmSync(join(PROJECT_CWD, ".pi"), { recursive: true, force: true });
}

const PROJECT_LOCATION: ProjectLocation = {
  path: PROJECT_CWD,
  physicalPath: PROJECT_CWD,
  name: "subagent-project",
  environment: { kind: "windows" },
};

// ============================================================================
// Faux pi-ai provider (only the REAL-runtime WSL tests need it)
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

function makeAssistantMessage(model: Model<Api>, opts: StreamScript): AssistantMessage {
  const content: AssistantMessage["content"] = [];
  if (opts.kind === "message" && opts.text) {
    content.push({ type: "text", text: opts.text });
  }
  if (opts.kind === "message" && opts.toolCall) {
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
    usage: opts.kind === "message" ? opts.usage ?? zeroUsage() : zeroUsage(),
    stopReason: opts.kind === "message" ? opts.stopReason ?? "stop" : "stop",
    errorMessage: opts.kind === "message" ? opts.errorMessage : undefined,
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
  provider.calls.length; // keep reference

  if (options?.signal?.aborted) {
    const aborted = makeAssistantMessage(model, { kind: "message", stopReason: "aborted" });
    stream.push({ type: "error", reason: "aborted", error: aborted });
    stream.end(aborted);
    return stream;
  }

  const script = provider.scripts.shift() ?? { kind: "message" as const, text: "", stopReason: "stop" as const };
  if (script.kind === "hang") {
    provider.pendingHangs.push({ stream, model });
    if (script.streamText) {
      const partial = makeAssistantMessage(model, { kind: "message", text: script.streamText });
      stream.push({ type: "start", partial });
      stream.push({ type: "text_delta", contentIndex: 0, delta: script.streamText, partial });
    }
    if (script.respondToAbort) {
      const onAbort = (): void => {
        const aborted = makeAssistantMessage(model, { kind: "message", text: script.abortText, stopReason: "aborted" });
        stream.push({ type: "error", reason: "aborted", error: aborted });
        stream.end(aborted);
      };
      options?.signal?.addEventListener("abort", onAbort, { once: true });
      if (options?.signal?.aborted) {
        onAbort();
      }
    }
    return stream;
  }

  const message = makeAssistantMessage(model, script);
  stream.push({ type: "start", partial: message });
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    stream.push({ type: "error", reason: message.stopReason, error: message });
  } else {
    stream.push({ type: "done", reason: "stop", message });
  }
  stream.end(message);
  return stream;
}

function releaseHangStream(stream: AssistantMessageEventStream, text = "done"): void {
  const index = provider.pendingHangs.findIndex((hang) => hang.stream === stream);
  if (index === -1) {
    throw new Error("Hang stream not found");
  }
  const [hang] = provider.pendingHangs.splice(index, 1);
  const message = makeAssistantMessage(hang.model, { kind: "message", text, stopReason: "stop" });
  hang.stream.push({ type: "done", reason: "stop", message });
  hang.stream.end(message);
}

// ============================================================================
// Fake runtime (service test hook) + fake timers + fake collector
// ============================================================================

function emptyUsage(): SubagentUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, turns: 0 };
}

class FakeRuntime {
  static instances: FakeRuntime[] = [];

  readonly spec: AgentTaskSpec;
  input: AgentTaskInputRouter | undefined;
  signal: AbortSignal | undefined;
  onEvent: ((event: AgentTaskRuntimeEventLike) => void) | undefined;
  abortCalls = 0;
  private _resolveRun: ((result: AgentTaskRuntimeResult) => void) | undefined;
  settled = false;

  constructor(spec: AgentTaskSpec) {
    this.spec = spec;
    FakeRuntime.instances.push(this);
  }

  run(signal: AbortSignal, onEvent: (event: AgentTaskRuntimeEventLike) => void): Promise<AgentTaskRuntimeResult> {
    this.signal = signal;
    this.onEvent = onEvent;
    return new Promise<AgentTaskRuntimeResult>((resolve) => {
      this._resolveRun = resolve;
    });
  }

  emitFileChange(change: FileChangeSummary, aggregate: TurnDiffSummary): void {
    this.onEvent?.({ type: "file_change", change, aggregate });
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

  private makeItemResult(item: AgentTaskSpec["items"][number], index: number): import("../../shared/subagent-types.js").SubagentSingleResult {
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
    // A real runtime settles as cancelled shortly after abort; mirror that.
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
    return Promise.resolve();
  }

  resolveInput(): boolean {
    return true;
  }

  cancelInput(): boolean {
    return true;
  }
}

type AgentTaskRuntimeEventLike =
  | { type: "activity"; activity: AgentTaskActivity }
  | { type: "output"; text: string; truncated: boolean; originalBytes: number }
  | { type: "file_change"; change: FileChangeSummary; aggregate: TurnDiffSummary };

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

function makeFakeTimers(baseNow: number): {
  now: () => number;
  setTimer: (callback: () => void, ms: number) => { cancel: () => void };
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
    fireMs: (ms) => {
      for (const entry of [...entries]) {
        if (!entry.cancelled && entry.ms === ms) {
          entry.callback();
        }
      }
    },
  };
}

// ============================================================================
// Unhandled rejection collector
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

// ============================================================================
// Facade harness (real service + fake runtime)
// ============================================================================

interface ApprovalControls {
  requestUserInput: (request: RequestUserInputRequest, signal?: AbortSignal) => Promise<RequestUserInputResponse>;
  approve: () => void;
  deny: () => void;
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
    lastRequest: () => lastRequest,
  };
}

interface FacadeHarness {
  service: AgentTaskService;
  runner: SubagentRunner;
  usageSink: SubagentUsage[];
  inputRequests: Array<{ request: RequestUserInputRequest; signal: AbortSignal | undefined }>;
  approvals: ApprovalControls;
  resolveHostDisposed: () => void;
  hostDisposed: Promise<"host_disposed">;
  loadedAgents: LoadAgentsResult;
  parentRuntime: {
    model: Model<Api> | undefined;
    thinkingLevel: ThinkingLevel;
    executionMode: AgentExecutionMode;
    verificationGate: boolean;
  };
  projectLocation: ProjectLocation;
}

function makeLoadedAgents(): LoadAgentsResult {
  return {
    agents: [
      {
        name: "general-purpose",
        description: "general purpose agent",
        systemPrompt: "general purpose system prompt",
        source: "built-in",
      },
      {
        name: "proj-a",
        description: "proj-a agent",
        systemPrompt: "proj-a system prompt",
        source: "project",
        filePath: join(PROJECT_CWD, ".pi", "agents", "proj-a.md"),
        baseDir: join(PROJECT_CWD, ".pi", "agents"),
      },
      {
        name: "shell-wsl",
        description: "wsl shell agent",
        systemPrompt: "wsl shell system prompt",
        source: "user",
        filePath: join(AGENTS_DIR, "shell-wsl.md"),
        baseDir: AGENTS_DIR,
        tools: ["run_background", "read"],
      },
      {
        name: "wild-wsl",
        description: "wild wsl agent",
        systemPrompt: "wild wsl system prompt",
        source: "user",
        filePath: join(AGENTS_DIR, "wild-wsl.md"),
        baseDir: AGENTS_DIR,
      },
    ],
    projectAgentsDir: join(PROJECT_CWD, ".pi", "agents"),
    diagnostics: [],
  };
}

/**
 * Fresh facade harness: real SettingsStore + fake collector, real
 * AgentTaskService with a fake runtime factory and auto-background disabled
 * unless overridden. The service hooks are replaced per harness; the previous
 * hooks are restored by the returned restore function.
 */
function makeHarness(extraHooks?: Partial<AgentTaskServiceTestHooks>): FacadeHarness {
  FakeRuntime.instances = [];
  const cwd = mkdtempSync(join(tmpdir(), "pix-subagent-facade-"));
  const settings = new SettingsStore({ cwd });
  settings.set("enableProductAnalytics", true);
  const events = new FakeCollector() as unknown as ProductEventCollector;
  const approvals = makeApprovalControls();
  let resolveHostDisposed: () => void = () => {};
  const hostDisposed = new Promise<"host_disposed">((resolve) => {
    resolveHostDisposed = () => resolve("host_disposed");
  });
  const service = new AgentTaskService({ settings, events, store: new AgentTaskStore({ rootDir: mkdtempSync(join(tmpdir(), "pix-subagent-runner-store-")), maxTaskBytes: 25 * 1024 * 1024, maxWorkspaceBytes: 500 * 1024 * 1024 }), runId: "runner-run" });
  __setAgentTaskServiceHooksForTests({
    autoBackgroundMsOverride: 0,
    runtimeFactory: (spec, input) => {
      const fake = new FakeRuntime(spec);
      fake.input = input;
      return fake as unknown as AgentTaskRuntime;
    },
    ...extraHooks,
  });

  const authStorage = AuthStorage.create(join(AGENT_DIR, "auth.json"));
  const registry = ModelRegistry.create(authStorage, join(AGENT_DIR, "models.json"));
  // Register the faux api on the shared pi-ai registry so real-runtime tests
  // (WSL isolation) dispatch to the faux provider.
  registry.registerProvider("faux", { api: "faux-api", streamSimple: fauxStream });
  const parentModel = registry.find("faux", "faux-model");

  const usageSink: SubagentUsage[] = [];
  const inputRequests: Array<{ request: RequestUserInputRequest; signal: AbortSignal | undefined }> = [];
  const parentRuntime = {
    model: parentModel,
    thinkingLevel: "high" as ThinkingLevel,
    executionMode: "approval" as AgentExecutionMode,
    verificationGate: true,
  };
  const loadedAgents = makeLoadedAgents();

  const ctx: SubagentExecutionContext = {
    physicalCwd: PROJECT_CWD,
    logicalCwd: PROJECT_CWD,
    agentDir: AGENT_DIR,
    executionBackend: undefined,
    runtimeEnvironmentOverride: undefined,
    authStorage,
    modelRegistry: registry,
    isWsl: false,
    getLoadedAgents: () => loadedAgents,
    getParentRuntime: () => parentRuntime,
    requestUserInput: (request, signal) => {
      inputRequests.push({ request, signal });
      return approvals.requestUserInput(request, signal);
    },
    recordAuxiliaryUsage: (usage) => {
      usageSink.push(usage);
    },
    getTaskService: () => service,
    getSessionId: () => "session-1",
    getProjectLocation: () => PROJECT_LOCATION,
  };
  const runner = new SubagentRunner(ctx);
  return {
    service,
    runner,
    usageSink,
    inputRequests,
    approvals,
    resolveHostDisposed,
    hostDisposed,
    loadedAgents,
    parentRuntime,
    projectLocation: PROJECT_LOCATION,
  };
}

function makeHost(h: FacadeHarness): SubagentToolHost {
  return {
    getRunner: () => h.runner,
    getTaskService: () => h.service,
    getSubmissionContext: (toolCallId: string) => h.runner.assembleSubmissionContext(toolCallId),
  };
}

/** Execute a tool definition; the ctx argument is unused by the agent tool. */
function executeTool(
  tool: ReturnType<typeof createSubagentToolDefinition>,
  toolCallId: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
  onUpdate?: (update: { content: Array<{ type: string; text?: string }>; details: unknown }) => void,
): ReturnType<ReturnType<typeof createSubagentToolDefinition>["execute"]> {
  return tool.execute(
    toolCallId,
    params as Parameters<ReturnType<typeof createSubagentToolDefinition>["execute"]>[1],
    signal,
    onUpdate as Parameters<ReturnType<typeof createSubagentToolDefinition>["execute"]>[3],
    undefined as never,
  );
}

// ============================================================================
// Prototype patch helper (capture the original BEFORE patching)
// ============================================================================

function patch<T extends object, K extends keyof T>(
  target: T,
  method: K,
  original: T[K],
  replacement: (this: T, ...args: never[]) => unknown,
): () => void {
  (target as Record<K, unknown>)[method] = replacement as T[K];
  return () => {
    (target as Record<K, unknown>)[method] = original;
  };
}

// ============================================================================
// Tests
// ============================================================================

await run("preflight: illegal task counts fail with invalid_parameters (facade-local)", async () => {
  clearAgents();
  const h = makeHarness();
  provider.calls.length = 0;

  const zero = await h.runner.run({ mode: "parallel", agentScope: "user", tasks: [] }, undefined);
  assert(isSubagentDetails(zero), "zero-task result passes the shared guard");
  assertEqual(zero.results[0].failureReason, "invalid_parameters", "zero tasks rejected");

  const many = await h.runner.run(
    { mode: "parallel", agentScope: "user", tasks: Array.from({ length: MAX_PARALLEL_TASKS + 1 }, () => ({ prompt: "t" })) },
    undefined,
  );
  assertEqual(many.results[0].failureReason, "invalid_parameters", "over-limit task count rejected");
  assertEqual(FakeRuntime.instances.length, 0, "no service submission for invalid counts");
});

await run("preflight failures via the service: unknown agent / prompt bounds / model failures", async () => {
  clearAgents();
  const h = makeHarness();
  provider.calls.length = 0;

  const unknown = await h.runner.run(
    { mode: "single", agentScope: "user", tasks: [{ subagent_type: "no-such-agent", prompt: "do something" }] },
    undefined,
  );
  assert(isSubagentDetails(unknown), "unknown-agent result passes the shared guard");
  assertEqual(unknown.results[0].status, "failed", "unknown agent status failed");
  assertEqual(unknown.results[0].failureReason, "unknown_agent", "unknown_agent reason");
  assertEqual(FakeRuntime.instances.length, 0, "no runtime for the unknown agent");

  const empty = await h.runner.run({ mode: "single", agentScope: "user", tasks: [{ prompt: "   " }] }, undefined);
  assertEqual(empty.results[0].failureReason, "prompt_too_large", "whitespace prompt rejected");

  const oversized = await h.runner.run(
    { mode: "single", agentScope: "user", tasks: [{ prompt: "x".repeat(MAX_DELEGATED_PROMPT_BYTES + 1) }] },
    undefined,
  );
  assertEqual(oversized.results[0].failureReason, "prompt_too_large", "over-limit prompt rejected");

  const noModel = await h.runner.run(
    {
      mode: "single",
      agentScope: "user",
      tasks: [
        {
          subagent_type: "proj-a",
          prompt: "p",
        },
      ],
    },
    undefined,
  );
  // proj-a is a project agent: the approval is requested and denied below.
  assertEqual(h.inputRequests.length, 0, "user-scope runs never request project approval");
  assertEqual(FakeRuntime.instances.length, 0, "no session created for invalid prompts");
});

await run("foreground single: completes with details and records aggregated usage exactly once", async () => {
  clearAgents();
  const h = makeHarness();
  provider.calls.length = 0;

  const runPromise = h.runner.run({ mode: "single", agentScope: "user", tasks: [{ prompt: "delegate" }] }, undefined);
  await waitFor(() => FakeRuntime.instances.length === 1, 20000, "runtime created");
  FakeRuntime.instances[0].complete();
  const details = await runPromise;

  assert(isSubagentDetails(details), "foreground result passes the shared guard");
  assertEqual(details.mode, "single", "mode single");
  assertEqual(details.results.length, 1, "one result");
  assertEqual(details.results[0].status, "completed", "completed");
  assertEqual(details.results[0].agentName, "general-purpose", "default agent name");
  assertEqual(details.results[0].finalOutput, "output-0", "result output");
  assertEqual(h.usageSink.length, 1, "usage recorded exactly once per foreground group");
});

await run("progress: queued -> running -> completed snapshots, immutable copies", async () => {
  clearAgents();
  const h = makeHarness();
  provider.calls.length = 0;
  const snapshots: SubagentDetails[] = [];

  const runPromise = h.runner.run({ mode: "single", agentScope: "user", tasks: [{ prompt: "go" }] }, undefined, (event) =>
    snapshots.push(event.details),
  );
  await waitFor(() => FakeRuntime.instances.length === 1, 20000, "runtime created");
  FakeRuntime.instances[0].complete();
  const details = await runPromise;

  assert(snapshots.length >= 2, "progress snapshots emitted");
  for (const snapshot of snapshots) {
    assert(isSubagentDetails(snapshot), "every snapshot passes the shared guard");
  }
  const firstQueued = snapshots.findIndex((s) => s.results[0].status === "queued");
  const firstRunning = snapshots.findIndex((s) => s.results[0].status === "running");
  const firstCompleted = snapshots.findIndex((s) => s.results[0].status === "completed");
  assert(firstQueued !== -1 && firstQueued < firstRunning && firstRunning < firstCompleted, "queued -> running -> completed order");

  // Immutability: mutating an emitted snapshot must not affect later ones.
  snapshots[0].results[0].finalOutput = "HACKED";
  assertEqual(details.results[0].finalOutput, "output-0", "final details unaffected by snapshot mutation");
});

await run("parent signal aborts the still-foreground group as user_cancel (aborted semantics)", async () => {
  clearAgents();
  const h = makeHarness();
  provider.calls.length = 0;
  const controller = new AbortController();

  const runPromise = h.runner.run({ mode: "single", agentScope: "user", tasks: [{ prompt: "go" }] }, controller.signal);
  await waitFor(() => FakeRuntime.instances.length === 1, 20000, "runtime created");
  controller.abort();
  const details = await runPromise;

  assert(isSubagentDetails(details), "aborted run passes the shared guard");
  assertEqual(details.results[0].status, "aborted", "cancelled group maps to aborted results");
  assertEqual(details.results[0].failureReason, "aborted", "aborted reason");
  assertEqual(FakeRuntime.instances[0].abortCalls, 1, "the facade cancelled the group through the service");
  // The group still completed in the foreground, so its usage lands once.
  assertEqual(h.usageSink.length, 1, "still-foreground group records its usage exactly once");
});

await run("foreground cancelled task maps to aborted result semantics; no deadlock", async () => {
  clearAgents();
  const h = makeHarness();
  provider.calls.length = 0;

  const runPromise = h.runner.run({ mode: "single", agentScope: "user", tasks: [{ prompt: "go" }] }, undefined);
  await waitFor(() => FakeRuntime.instances.length === 1, 20000, "runtime created");
  await h.service.cancel(FakeRuntime.instances[0].spec.taskId, 0, "user_cancel");
  const details = await runPromise;
  assertEqual(details.results[0].status, "aborted", "cancelled task maps to aborted");
  // The group still completed in the foreground (cancelled), so usage lands once.
  assertEqual(h.usageSink.length, 1, "still-foreground cancelled group records usage once");
});

await run("dispose: host_disposed wins the preflight approval race; run after dispose is rejected", async () => {
  clearAgents();
  const h = makeHarness();
  provider.calls.length = 0;
  const runPromise = h.runner.run(
    { mode: "single", agentScope: "both", tasks: [{ subagent_type: "proj-a", prompt: "p" }] },
    undefined,
  );
  await waitFor(() => h.inputRequests.length === 1, 20000, "project approval requested");
  const disposePromise = h.runner.dispose();
  const details = await runPromise;
  await disposePromise;
  await h.runner.dispose(); // idempotent
  assertEqual(details.results[0].status, "aborted", "close-driven approval rejection is aborted");
  assertEqual(details.results[0].failureReason, "host_disposed", "host_disposed classification, never a user denial");

  const after = await h.runner.run({ mode: "single", agentScope: "user", tasks: [{ prompt: "late" }] }, undefined);
  assertEqual(after.results[0].status, "aborted", "run after dispose is rejected");
  assertEqual(after.results[0].failureReason, "host_disposed", "run after dispose host_disposed");
});

await run("run_in_background=true returns the group handle without awaiting", async () => {
  clearAgents();
  const h = makeHarness();
  provider.calls.length = 0;

  const result = await h.runner.run(
    { mode: "single", agentScope: "user", tasks: [{ prompt: "bg" }] },
    undefined,
    undefined,
    undefined,
    { runInBackground: true, parentToolCallId: "tc-bg" } satisfies SubagentRunOptions,
  );
  assert("kind" in result, "background run resolves with a handle, never details");
  assertEqual(result.kind, "agent_task_group", "handle kind");
  assertEqual(result.tasks.length, 1, "one task in the handle");
  assertEqual(result.tasks[0].status, "running", "task already running (preflight finished)");
  const info = h.service.getAll().tasks.find((task) => task.taskId === result.tasks[0].taskId);
  assertEqual(info?.parentToolCallId, "tc-bg", "submission carries the parent tool call id");
  assertEqual(h.usageSink.length, 0, "background runs never write usage into the parent accumulator");
});

await run("auto-background under an injectable short clock flips presentation without releasing the await", async () => {
  clearAgents();
  const baseNow = Date.now();
  const timers = makeFakeTimers(baseNow);
  const h = makeHarness({ autoBackgroundMsOverride: 60_000, now: timers.now, setTimer: timers.setTimer });
  provider.calls.length = 0;

  const runPromise = h.runner.run({ mode: "single", agentScope: "user", tasks: [{ prompt: "long" }] }, undefined);
  await waitFor(() => FakeRuntime.instances.length === 1, 20000, "runtime created");
  assertEqual(FakeRuntime.instances[0].abortCalls, 0, "no restart before the deadline");
  timers.fireMs(60_000);
  const pending = await Promise.race([runPromise.then(() => "resolved" as const), drain().then(() => "pending" as const)]);
  assertEqual(pending, "pending", "auto-background does not resolve the parent await");
  assertEqual(FakeRuntime.instances[0].abortCalls, 0, "auto-background never restarts the task");
  assertEqual(FakeRuntime.instances[0].settled, false, "the task keeps running in the service");
  const info = h.service.getAll().tasks.find((task) => task.taskId === FakeRuntime.instances[0].spec.taskId);
  assertEqual(info?.presentation, "background", "child presentation flipped to background");
  FakeRuntime.instances[0].complete();
  const result = await runPromise;
  assert(isSubagentDetails(result), "foreground await still returns SubagentDetails");
});

await run("manual background detaches the group and resolves the single tool await", async () => {
  clearAgents();
  const h = makeHarness();
  provider.calls.length = 0;

  const runPromise = h.runner.run({ mode: "single", agentScope: "user", tasks: [{ prompt: "bg" }] }, undefined);
  await waitFor(() => FakeRuntime.instances.length === 1, 20000, "runtime created");
  // 1.5 (P1): manual background is gone; the session-switch detach path is the
  // detach entry point.
  const detached = h.service.detachForegroundGroupsForSession("session-1");
  assertEqual(detached.length, 1, "session detach detaches the group");
  const result = await runPromise;
  assert("kind" in result, "session detach resolves with the handle");
  assertEqual(result.kind, "agent_task_group", "handle kind");
  assertEqual(h.usageSink.length, 0, "backgrounded group writes no usage");
});

await run("parallel group handle lists every child; chain stays a single task", async () => {
  clearAgents();
  const h = makeHarness();
  provider.calls.length = 0;

  const parallel = await h.runner.run(
    { mode: "parallel", agentScope: "user", tasks: [{ prompt: "t1" }, { prompt: "t2" }, { prompt: "t3" }] },
    undefined,
    undefined,
    undefined,
    { runInBackground: true },
  );
  assert("kind" in parallel && parallel.kind === "agent_task_group", "parallel background returns a group handle");
  assertEqual(parallel.tasks.length, 3, "one child per parallel item");
  assertEqual(parallel.mode, "parallel", "handle mode parallel");

  const chain = await h.runner.run(
    { mode: "chain", agentScope: "user", tasks: [{ prompt: "s1" }, { prompt: "s2" }] },
    undefined,
    undefined,
    undefined,
    { runInBackground: true },
  );
  assert("kind" in chain && chain.kind === "agent_task_group", "chain background returns a group handle");
  assertEqual(chain.tasks.length, 1, "chain stays a single task");
  assertEqual(chain.mode, "chain", "handle mode chain");

  // Foreground chain: details keep the per-step results. All 4 slots are held
  // by the backgrounded tasks, so free one first (the queued chain then starts).
  FakeRuntime.instances[0].complete();
  const chainRun = h.runner.run({ mode: "chain", agentScope: "user", tasks: [{ prompt: "s1" }, { prompt: "s2" }] }, undefined);
  await waitFor(() => FakeRuntime.instances.length === 5, 20000, "chain runtime created");
  FakeRuntime.instances[4].complete();
  const chainDetails = await chainRun;
  assert(isSubagentDetails(chainDetails), "chain foreground passes the guard");
  assertEqual(chainDetails.mode, "chain", "chain mode");
  assertEqual(chainDetails.results.length, 2, "chain keeps both step results");
  assertEqual(chainDetails.results[1].step, 2, "step 2");
});

await run("file_change: facade forwards group task file changes to the onFileChange callback", async () => {
  clearAgents();
  const h = makeHarness();
  provider.calls.length = 0;
  const changes: Array<{ change: FileChangeSummary; aggregate: TurnDiffSummary }> = [];

  const runPromise = h.runner.run(
    { mode: "single", agentScope: "user", tasks: [{ prompt: "go" }] },
    undefined,
    undefined,
    (event) => changes.push(event),
  );
  await waitFor(() => FakeRuntime.instances.length === 1, 20000, "runtime created");
  FakeRuntime.instances[0].emitFileChange(
    { path: "src/a.txt", toolCallId: "fc-1", toolName: "edit", added: 1, removed: 0 },
    { added: 1, removed: 0, files: 1, changes: [] },
  );
  await waitFor(() => changes.length === 1, 20000, "file change forwarded");
  assertEqual(changes[0].change.path, "src/a.txt", "change forwarded verbatim");
  FakeRuntime.instances[0].complete();
  await runPromise;
});

await run("WSL runtime isolation: explicit shell background tools fail tool_unavailable", async () => {
  clearAgents();
  const wslLocation: ProjectLocation = {
    path: "/home/u/repo",
    physicalPath: PROJECT_CWD,
    name: "wsl-repo",
    environment: { kind: "wsl", distro: "Ubuntu-22.04" },
  };
  const fakeBackend: ExecutionBackend = {
    paths: {
      pathStyle: "posix",
      homeDir: "/home/u",
      resolvePath: (input: string, cwd: string) => (input.startsWith("/") ? input : join(cwd, input)),
    },
    runtimeEnvironment: { platform: "linux", osName: "WSL2 (Ubuntu-22.04)", shell: { kind: "wsl", path: "wsl.exe" } },
    getCwd: () => "/home/u/repo",
    dispose: async () => {},
  };
  const restoreContext = __setAgentTaskRuntimeContextFactoriesForTests(
    async () => ({
      location: wslLocation,
      logicalCwd: wslLocation.path,
      physicalCwd: wslLocation.physicalPath,
      executionBackend: fakeBackend,
      runtimeEnvironmentOverride: fakeBackend.runtimeEnvironment,
      isWsl: true,
    }),
    async (context) => {
      await disposeProjectExecutionContext(context);
    },
  );
  const restoreServiceHooks = (() => {
    let prev: AgentTaskServiceTestHooks | undefined;
    __setAgentTaskServiceHooksForTests(undefined as never);
    return () => {
      __setAgentTaskServiceHooksForTests(prev);
    };
  })();

  try {
    // The real runtime is used (no runtimeFactory hook) with a WSL project.
    const cwd = mkdtempSync(join(tmpdir(), "pix-subagent-wsl-"));
    const settings = new SettingsStore({ cwd });
    settings.set("enableProductAnalytics", true);
    const events = new FakeCollector() as unknown as ProductEventCollector;
    const service = new AgentTaskService({ settings, events, store: new AgentTaskStore({ rootDir: mkdtempSync(join(tmpdir(), "pix-subagent-runner-store-")), maxTaskBytes: 25 * 1024 * 1024, maxWorkspaceBytes: 500 * 1024 * 1024 }), runId: "runner-run" });
    __setAgentTaskServiceHooksForTests({ autoBackgroundMsOverride: 0 });

    const authStorage = AuthStorage.create(join(AGENT_DIR, "auth.json"));
    const registry = ModelRegistry.create(authStorage, join(AGENT_DIR, "models.json"));
    registry.registerProvider("faux", { api: "faux-api", streamSimple: fauxStream });
    const parentModel = registry.find("faux", "faux-model");
    const ctx: SubagentExecutionContext = {
      physicalCwd: PROJECT_CWD,
      logicalCwd: wslLocation.path,
      agentDir: AGENT_DIR,
      executionBackend: undefined,
      runtimeEnvironmentOverride: undefined,
      authStorage,
      modelRegistry: registry,
      isWsl: true,
      getLoadedAgents: () => makeLoadedAgents(),
      getParentRuntime: () => ({
        model: parentModel,
        thinkingLevel: "high",
        executionMode: "approval",
        verificationGate: true,
      }),
      requestUserInput: async (request) => ({ id: request.id, cancelled: false, answers: { allow_project_agents: "允许" } }),
      recordAuxiliaryUsage: () => {},
      getTaskService: () => service,
      getSessionId: () => "session-wsl",
      getProjectLocation: () => wslLocation,
    };
    const runner = new SubagentRunner(ctx);
    provider.calls.length = 0;
    provider.scripts.length = 0;

    // Explicit tools listing a shell background tool fail before any session.
    const details = await runner.run(
      { mode: "single", agentScope: "user", tasks: [{ subagent_type: "shell-wsl", prompt: "go" }] },
      undefined,
    );
    assertEqual(details.results[0].status, "failed", "explicit shell background tool fails");
    assertEqual(details.results[0].failureReason, "tool_unavailable", "tool_unavailable reason");
    assert(details.results[0].errorMessage?.includes("run_background") === true, "missing tool named in the error");
    assertEqual(provider.calls.length, 0, "no provider call for the denied tool set");
  } finally {
    restoreContext();
    __setAgentTaskServiceHooksForTests(undefined);
  }
  assertNoUnhandledRejections();
});

await run("WSL runtime isolation: all-tools activation excludes shell background tools; Windows keeps them", async () => {
  clearAgents();
  const wslLocation: ProjectLocation = {
    path: "/home/u/repo",
    physicalPath: PROJECT_CWD,
    name: "wsl-repo",
    environment: { kind: "wsl", distro: "Ubuntu-22.04" },
  };
  const fakeBackend: ExecutionBackend = {
    paths: {
      pathStyle: "posix",
      homeDir: "/home/u",
      resolvePath: (input: string, cwd: string) => (input.startsWith("/") ? input : join(cwd, input)),
    },
    runtimeEnvironment: { platform: "linux", osName: "WSL2 (Ubuntu-22.04)", shell: { kind: "wsl", path: "wsl.exe" } },
    getCwd: () => "/home/u/repo",
    dispose: async () => {},
  };
  const restoreContext = __setAgentTaskRuntimeContextFactoriesForTests(
    async (location: ProjectLocation) => ({
      location,
      logicalCwd: wslLocation.path,
      physicalCwd: wslLocation.physicalPath,
      executionBackend: fakeBackend,
      runtimeEnvironmentOverride: fakeBackend.runtimeEnvironment,
      isWsl: location.environment.kind === "wsl",
    }),
    async (context) => {
      await disposeProjectExecutionContext(context);
    },
  );

  const seenTools: string[][] = [];
  const activatedNames: string[][] = [];
  const origGetAll = AgentSession.prototype.getAllTools;
  const origSetActive = AgentSession.prototype.setActiveToolsByName;
  const restoreGetAll = patch(AgentSession.prototype, "getAllTools", origGetAll, function (this: AgentSession) {
    const result = origGetAll.call(this);
    seenTools.push(result.map((t) => t.name));
    return result;
  });
  const restoreSetActive = patch(AgentSession.prototype, "setActiveToolsByName", origSetActive, function (this: AgentSession, names: string[]) {
    activatedNames.push([...names]);
    return origSetActive.call(this, names);
  });

  try {
    const cwd = mkdtempSync(join(tmpdir(), "pix-subagent-wsl2-"));
    const settings = new SettingsStore({ cwd });
    settings.set("enableProductAnalytics", true);
    const events = new FakeCollector() as unknown as ProductEventCollector;
    const service = new AgentTaskService({ settings, events, store: new AgentTaskStore({ rootDir: mkdtempSync(join(tmpdir(), "pix-subagent-runner-store-")), maxTaskBytes: 25 * 1024 * 1024, maxWorkspaceBytes: 500 * 1024 * 1024 }), runId: "runner-run" });
    __setAgentTaskServiceHooksForTests({ autoBackgroundMsOverride: 0 });

    const authStorage = AuthStorage.create(join(AGENT_DIR, "auth.json"));
    const registry = ModelRegistry.create(authStorage, join(AGENT_DIR, "models.json"));
    registry.registerProvider("faux", { api: "faux-api", streamSimple: fauxStream });
    const parentModel = registry.find("faux", "faux-model");
    const ctx: SubagentExecutionContext = {
      physicalCwd: PROJECT_CWD,
      logicalCwd: wslLocation.path,
      agentDir: AGENT_DIR,
      executionBackend: undefined,
      runtimeEnvironmentOverride: undefined,
      authStorage,
      modelRegistry: registry,
      isWsl: true,
      getLoadedAgents: () => makeLoadedAgents(),
      getParentRuntime: () => ({
        model: parentModel,
        thinkingLevel: "high",
        executionMode: "approval",
        verificationGate: true,
      }),
      requestUserInput: async (request) => ({ id: request.id, cancelled: false, answers: { allow_project_agents: "允许" } }),
      recordAuxiliaryUsage: () => {},
      getTaskService: () => service,
      getSessionId: () => "session-wsl",
      getProjectLocation: () => wslLocation,
    };
    const runner = new SubagentRunner(ctx);

    // WSL all-tools agent: the shell background tools are denylisted at
    // session creation and can never be re-added by the all-tools activation.
    provider.calls.length = 0;
    provider.scripts.length = 0;
    provider.scripts.push({ kind: "message", text: "ok", stopReason: "stop" });
    const wslDetails = await runner.run(
      { mode: "single", agentScope: "user", tasks: [{ subagent_type: "wild-wsl", prompt: "go" }] },
      undefined,
    );
    assertEqual(wslDetails.results[0].status, "completed", "WSL all-tools run completes");
    const allSeen = new Set(seenTools.flat());
    for (const tool of SHELL_BACKGROUND_TOOLS) {
      assert(!allSeen.has(tool), `WSL session never registers ${tool}`);
    }
    const allActivated = new Set(activatedNames.flat());
    for (const tool of SHELL_BACKGROUND_TOOLS) {
      assert(!allActivated.has(tool), `WSL all-tools activation never re-adds ${tool}`);
    }
    assert(allActivated.has("bash") && allActivated.has("read"), "ordinary tools still activated on WSL");

    // Windows runtime keeps the shell background tools available.
    seenTools.length = 0;
    activatedNames.length = 0;
    provider.calls.length = 0;
    provider.scripts.length = 0;
    provider.scripts.push({ kind: "message", text: "win", stopReason: "stop" });
    const winCtx: SubagentExecutionContext = {
      ...ctx,
      isWsl: false,
      logicalCwd: PROJECT_CWD,
      getProjectLocation: () => PROJECT_LOCATION,
    };
    const winRunner = new SubagentRunner(winCtx);
    const winDetails = await winRunner.run(
      { mode: "single", agentScope: "user", tasks: [{ subagent_type: "wild-wsl", prompt: "go" }] },
      undefined,
    );
    assertEqual(winDetails.results[0].status, "completed", "Windows all-tools run completes");
    const winSeen = new Set(seenTools.flat());
    for (const tool of SHELL_BACKGROUND_TOOLS) {
      assert(winSeen.has(tool), `Windows session keeps ${tool} available`);
    }
  } finally {
    restoreContext();
    restoreGetAll();
    restoreSetActive();
    __setAgentTaskServiceHooksForTests(undefined);
  }
  assertNoUnhandledRejections();
});

await run("tool: schema defaults run_in_background to false and the description forbids self-selection", async () => {
  clearAgents();
  const h = makeHarness();
  const tool = createSubagentToolDefinition(makeHost(h));
  assertEqual(tool.name, SUBAGENT_TOOL_NAME, "tool name is 'agent'");
  assertEqual(tool.executionMode, "parallel", "executionMode parallel retained");
  const parameters = tool.parameters as unknown as { properties?: Record<string, { default?: unknown }> };
  const backgroundParam = parameters.properties?.run_in_background;
  assert(backgroundParam !== undefined, "run_in_background parameter present");
  assertEqual(backgroundParam!.default, false, "run_in_background defaults to false");
  assert(tool.description.includes("run_in_background"), "description documents the parameter");
  assert(
    tool.description.includes("explicitly requested") && tool.description.includes("never infer"),
    "description forbids self-selecting the background by duration",
  );
  assert(
    tool.promptGuidelines?.some((g) => g.includes("run_in_background") && g.includes("explicitly asked")) === true,
    "prompt guidelines carry the same gate",
  );
});

await run("tool: invalid parameters return a structured failed result, never throw", async () => {
  clearAgents();
  const h = makeHarness();
  const tool = createSubagentToolDefinition(makeHost(h));
  provider.calls.length = 0;

  const empty = await executeTool(tool, "tc-1", {});
  assertEqual(empty.details.results[0].failureReason, "invalid_parameters", "empty params -> invalid_parameters");
  assert(
    empty.content.some((c) => c.type === "text" && c.text.includes("Exactly one of prompt, tasks or chain")),
    "error text in content",
  );
  assert(isSubagentDetails(empty.details), "invalid details pass the guard");

  const both = await executeTool(tool, "tc-2", { prompt: "p", tasks: [{ prompt: "t" }] });
  assertEqual(both.details.results[0].failureReason, "invalid_parameters", "prompt+tasks -> invalid_parameters");
  assertEqual(FakeRuntime.instances.length, 0, "no submission for invalid params");
});

await run("tool: single normalization defaults and description fallback", async () => {
  clearAgents();
  const h = makeHarness();
  const tool = createSubagentToolDefinition(makeHost(h));
  provider.calls.length = 0;

  const run1 = executeTool(tool, "tc-1", {
    subagent_type: "general-purpose",
    prompt: "do the thing",
    description: "my label",
  });
  await waitFor(() => FakeRuntime.instances.length === 1, 20000, "first runtime created");
  FakeRuntime.instances[0].complete();
  const withDescription = await run1;
  assert(isSubagentDetails(withDescription.details), "foreground details pass the guard");
  assertEqual(withDescription.details.results[0].description, "my label", "caller description wins");
  assertEqual(withDescription.details.mode, "single", "single mode");
  assertEqual(withDescription.details.agentScope, "user", "scope defaults to user");

  const run2 = executeTool(tool, "tc-2", { prompt: "first line\nsecond" });
  await waitFor(() => FakeRuntime.instances.length === 2, 20000, "second runtime created");
  FakeRuntime.instances[1].complete();
  const noDescription = await run2;
  assertEqual(noDescription.details.results[0].agentName, "general-purpose", "missing subagent_type defaults to general-purpose");
  assert(noDescription.details.results[0].description.startsWith("first line"), "description falls back to the first prompt line");
  assert(noDescription.details.results[0].description.length <= 80, "description capped at 80 chars");
});

await run("tool: run_in_background=true resolves to a group handle details (never SubagentDetails)", async () => {
  clearAgents();
  const h = makeHarness();
  const tool = createSubagentToolDefinition(makeHost(h));
  provider.calls.length = 0;

  const result = await executeTool(tool, "tc-bg", { prompt: "background it", run_in_background: true });
  assert("kind" in result.details, "background execute resolves with a handle");
  assertEqual(result.details.kind, "agent_task_group", "handle kind");
  assertEqual(result.details.tasks.length, 1, "single task in the handle");
  const contentText = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  assert(contentText.includes("background"), "content announces the background start");
  assert(contentText.includes(result.details.groupId), "content carries the group id");
});

await run("tool: foreground parallel final content and bounded onUpdate progress", async () => {
  clearAgents();
  const h = makeHarness();
  const tool = createSubagentToolDefinition(makeHost(h));
  provider.calls.length = 0;
  const updates: Array<{ content: string; details: unknown }> = [];

  const executePromise = executeTool(tool, "tc-1", { tasks: [{ prompt: "t1" }, { prompt: "t2" }] }, undefined, (update) => {
    updates.push({
      content: update.content.map((c) => (c.type === "text" ? c.text : "")).join(""),
      details: update.details,
    });
  });
  await waitFor(() => FakeRuntime.instances.length === 2, 20000, "both parallel runtimes created");
  FakeRuntime.instances[0].complete();
  FakeRuntime.instances[1].complete();
  const parallel = await executePromise;
  assert(isSubagentDetails(parallel.details), "parallel foreground details pass the guard");
  assertEqual(parallel.details.mode, "parallel", "parallel mode");
  const contentText = parallel.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  assert(contentText.startsWith("2/2 subagent tasks succeeded."), "N/M succeeded summary");
  assert(updates.length >= 1, "onUpdate called during progress");
  for (const update of updates) {
    assert(utf8ByteLength(update.content) < 1000, "onUpdate content is a single bounded status line");
    assert(isSubagentDetails(update.details as SubagentDetails), "onUpdate details pass the guard");
  }
});

await run("tool: no service available fails closed with a structured failed result", async () => {
  clearAgents();
  const authStorage = AuthStorage.create(join(AGENT_DIR, "auth.json"));
  const registry = ModelRegistry.create(authStorage, join(AGENT_DIR, "models.json"));
  const bareCtx: SubagentExecutionContext = {
    physicalCwd: PROJECT_CWD,
    logicalCwd: PROJECT_CWD,
    agentDir: AGENT_DIR,
    executionBackend: undefined,
    runtimeEnvironmentOverride: undefined,
    authStorage,
    modelRegistry: registry,
    isWsl: false,
    getLoadedAgents: () => makeLoadedAgents(),
    getParentRuntime: () => ({ model: undefined, thinkingLevel: "off", executionMode: "approval", verificationGate: false }),
    requestUserInput: async (request) => ({ id: request.id, cancelled: false, answers: {} }),
    recordAuxiliaryUsage: () => {},
    getTaskService: () => undefined,
    getSessionId: () => "session-none",
    getProjectLocation: () => PROJECT_LOCATION,
  };
  const runner = new SubagentRunner(bareCtx);
  const host: SubagentToolHost = {
    getRunner: () => runner,
    getTaskService: () => {
      throw new Error("no service");
    },
    getSubmissionContext: (toolCallId: string) => runner.assembleSubmissionContext(toolCallId),
  };
  const tool = createSubagentToolDefinition(host);
  const result = await executeTool(tool, "tc-1", { prompt: "go" });
  assert(isSubagentDetails(result.details), "no-service result passes the guard");
  assertEqual(result.details.results[0].status, "failed", "no-service fails closed");
  assertEqual(result.details.results[0].failureReason, "internal_error", "internal_error reason");
  assert(result.details.results[0].errorMessage?.includes("service") === true, "message names the missing service");
});

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

// ============================================================================

rmSync(AGENT_DIR, { recursive: true, force: true });
rmSync(PROJECT_CWD, { recursive: true, force: true });

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
