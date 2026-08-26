/**
 * AgentTaskRuntime tests (B2).
 *
 * Uses a faux pi-ai api provider (registerApiProvider via the coding-agent
 * ModelRegistry) so every nested session runs the REAL createAgentSession /
 * bindExtensions / prompt machinery with a controllable LLM stream; the
 * runtime's OWN AuthStorage/ModelRegistry (created from the temp agentDir)
 * resolve the same faux models. The AgentTaskInputRouter (B3) is replaced by a
 * structural mock capturing enqueue calls; responses are delivered through the
 * runtime's resolveInput/cancelInput service wiring.
 *
 * Run with: npm exec tsx -- src/main/__tests__/agent-task-runtime.test.ts
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, AssistantMessageEventStream, Context, Model, SimpleStreamOptions, Usage } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, type Api } from "@earendil-works/pi-ai";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ExecutionBackend } from "@earendil-works/pi-coding-agent";
import { createProjectExecutionContext, disposeProjectExecutionContext } from "../execution-context.js";
import type { RequestUserInputRequest, RequestUserInputResponse } from "../../shared/types.js";
import type { ProjectLocation } from "../../shared/project-location.js";
import type { AgentTaskItemSpec, AgentTaskSpec } from "../../shared/agent-task-types.js";
import type { SubagentSingleResult } from "../../shared/subagent-types.js";
import type { TaskCheckpoint } from "../agent-task/agent-task-store.js";
import { workspaceIdOf } from "../agent-task/agent-task-identity.js";
import { WslDistroResolver, type WslAutomountConfig, type WslDistroInfo } from "../wsl/wsl-distro.js";
import { WslPathConverter } from "../wsl/wsl-paths.js";
import { createWslExecutionBackend } from "../wsl/wsl-execution-backend.js";
import type { AgentTaskInputRouter } from "../agent-task/agent-task-input.js";
import {
  AgentTaskRuntime,
  MAX_DELEGATED_PROMPT_BYTES,
  __setAgentTaskRuntimeContextFactoriesForTests,
} from "../agent-task/agent-task-runtime.js";
import { schemaChildCompletionPrompt } from "../workflow/structured-output-tool.js";

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
// Fakes
// ============================================================================

interface FakeResolverConfig {
  distros: WslDistroInfo[];
  home: string;
  automount: WslAutomountConfig;
}

/**
 * Fake WSL distro resolver (same pattern as execution-context.test.ts): every
 * async probe is overridden with canned values so no wsl.exe is spawned.
 */
class FakeResolver extends WslDistroResolver {
  private readonly _distros: WslDistroInfo[];
  private readonly _home: string;
  private readonly _automount: WslAutomountConfig;

  constructor(config: FakeResolverConfig) {
    super({ listTimeoutMs: 500, probeTimeoutMs: 500 });
    this._distros = config.distros;
    this._home = config.home;
    this._automount = config.automount;
  }

  override async list(): Promise<WslDistroInfo[]> {
    return this._distros;
  }

  override async requireDistro(name: string): Promise<WslDistroInfo> {
    const match = this._distros.find((d) => d.name === name);
    if (!match) {
      throw new Error(`WSL distro "${name}" was not found.`);
    }
    if (match.version !== 2) {
      throw new Error(`WSL distro "${name}" is version ${match.version}; PiX WSL support requires WSL2 (version 2).`);
    }
    return match;
  }

  override async assertDirectory(_distro: string, _logicalCwd: string): Promise<void> {}

  override async getHome(_distro: string): Promise<string> {
    return this._home;
  }

  override async getAutomountConfig(_distro: string): Promise<WslAutomountConfig> {
    return this._automount;
  }
}

// ============================================================================
// Shared temp environment (agentDir + project cwd)
// ============================================================================

const AGENT_DIR = mkdtempSync(join(tmpdir(), "pix-agent-task-agent-"));
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
const PROJECT_CWD = mkdtempSync(join(tmpdir(), "pix-agent-task-project-"));

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
          id: "faux-chain-model",
          name: "Faux Chain Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
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

// Register the faux api ON the pi-ai instance the coding-agent dist uses
// (registerProvider wires through its own api-registry), so nested session
// streamFn calls dispatch to the faux provider even though every runtime builds
// its own ModelRegistry from the same models.json on disk.
const HARNESS_AUTH = AuthStorage.create(join(AGENT_DIR, "auth.json"));
const HARNESS_REGISTRY = ModelRegistry.create(HARNESS_AUTH, join(AGENT_DIR, "models.json"));

// ============================================================================
// Faux pi-ai provider
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
  maxActive: 0,
  active: 0,
};

function trackStream(stream: AssistantMessageEventStream, call: ProviderCall): void {
  provider.active++;
  provider.maxActive = Math.max(provider.maxActive, provider.active);
  stream.result().finally(() => {
    provider.active--;
    call.endedAt = Date.now();
  });
}

function fauxStream(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
  const call: ProviderCall = { model, context, options, startedAt: Date.now(), endedAt: undefined };
  provider.calls.push(call);

  const stream = createAssistantMessageEventStream();
  trackStream(stream, call);

  // An already-aborted signal: mirror real providers by ending with an
  // aborted message instead of a hanging stream.
  if (options?.signal?.aborted) {
    const aborted = makeAssistantMessage(model, { stopReason: "aborted" });
    stream.push({ type: "error", reason: "aborted", error: aborted });
    stream.end(aborted);
    return stream;
  }

  const script = provider.scripts.shift() ?? { kind: "message", text: "", stopReason: "stop" };
  if (script.kind === "hang") {
    provider.pendingHangs.push({ stream, model });
    if (script.streamText) {
      const partial = makeAssistantMessage(model, { text: script.streamText });
      stream.push({ type: "start", partial });
      stream.push({ type: "text_delta", contentIndex: 0, delta: script.streamText, partial });
    }
    if (script.respondToAbort) {
      const onAbort = (): void => {
        const aborted = makeAssistantMessage(model, { text: script.abortText, stopReason: "aborted" });
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

/** Concatenated text of the last user message in a provider call context. */
function userMessageText(call: ProviderCall): string {
  const userMessages = call.context.messages.filter((m) => m.role === "user");
  const parts: string[] = [];
  for (const message of userMessages) {
    const content = (message as { content?: unknown }).content;
    if (Array.isArray(content)) {
      for (const block of content as Array<{ type?: string; text?: string }>) {
        if (block.type === "text" && block.text) {
          parts.push(block.text);
        }
      }
    } else if (typeof content === "string") {
      parts.push(content);
    }
  }
  return parts.join("");
}

/** End a specific hanging stream (identity-based, indices shift as new hangs append). */
function releaseHangStream(stream: AssistantMessageEventStream, text = "done"): void {
  const index = provider.pendingHangs.findIndex((hang) => hang.stream === stream);
  if (index === -1) {
    throw new Error("Hang stream not found");
  }
  const [hang] = provider.pendingHangs.splice(index, 1);
  const message = makeAssistantMessage(hang.model, { text, stopReason: "stop" });
  hang.stream.push({ type: "done", reason: "stop", message });
  hang.stream.end(message);
}

HARNESS_REGISTRY.registerProvider("faux", { api: "faux-api", streamSimple: fauxStream });

// ============================================================================
// Spec / item builders
// ============================================================================

let taskCounter = 0;

function makeLocation(): ProjectLocation {
  return {
    path: PROJECT_CWD,
    physicalPath: PROJECT_CWD,
    name: "runtime-test",
    environment: { kind: "windows" },
  };
}

function makeSpec(overrides: Partial<AgentTaskSpec> = {}): AgentTaskSpec {
  taskCounter++;
  const location = makeLocation();
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
    verificationGate: true,
    project: location,
    workspaceId: workspaceIdOf(location.physicalPath),
    agentDir: AGENT_DIR,
    parentSessionId: "parent-session",
    parentToolCallId: "parent-tool-call",
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeReadyItem(overrides: Partial<AgentTaskItemSpec> = {}): AgentTaskItemSpec {
  return {
    resolution: "ready",
    index: 0,
    prompt: "do the thing",
    description: "A runtime test item",
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

function makeRejectedItem(overrides: Partial<AgentTaskItemSpec> = {}): AgentTaskItemSpec {
  return {
    resolution: "rejected",
    index: 0,
    prompt: "do the thing",
    description: "A rejected test item",
    failureReason: "unknown_agent",
    errorMessage: "Unknown agent \"no-such-agent\".",
    ...overrides,
  };
}

// ============================================================================
// Structural mock for the AgentTaskInputRouter (B3 creates the real file; this
// module type-imports it, tsx erases the import, the mock has the §4.5 shape).
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
// Tests
// ============================================================================

await run("completed: single item runs a real nested session and streams output", async () => {
  provider.scripts.length = 0;
  provider.calls.length = 0;
  provider.scripts.push({ kind: "message", text: "result text", stopReason: "stop" });

  const spec = makeSpec({ items: [makeReadyItem()] });
  const input = makeInputMock();
  const runtime = new AgentTaskRuntime({ spec, input: input.router });
  const events: string[] = [];
  const result = await runtime.run(new AbortController().signal, (e) => {
    events.push(e.type);
  });

  assertEqual(result.status, "completed", "task completed");
  assertEqual(result.results.length, 1, "one result");
  assertEqual(result.results[0].status, "completed", "result completed");
  assertEqual(result.results[0].finalOutput, "result text", "final output");
  assertEqual(result.results[0].model, "faux/faux-model", "model label");
  assertEqual(provider.calls.length, 1, "one provider call");
  assertEqual(provider.calls[0].options?.reasoning, "high", "spec thinkingLevel applied");
  assertEqual(result.usage.turns, 1, "usage turns aggregated");
  assert(events.includes("output"), "output events forwarded");
  assert(events.includes("file_change") === false, "no file_change without edits");

  await runtime.dispose();
});

await run("completed: activity + file_change forwarded for a nested write", async () => {
  provider.scripts.length = 0;
  provider.calls.length = 0;
  provider.scripts.push(
    {
      kind: "message",
      text: "",
      stopReason: "stop",
      toolCall: { name: "write", id: "nested-write-1", args: { path: "runtime-out.txt", content: "boom" } },
    },
    { kind: "message", text: "done", stopReason: "stop" },
  );

  const spec = makeSpec({ items: [makeReadyItem()] });
  const input = makeInputMock();
  const runtime = new AgentTaskRuntime({ spec, input: input.router });
  const activities: Array<{ toolName: string; status: string }> = [];
  const fileChanges: Array<{ path: string | undefined; toolCallId: string }> = [];
  const result = await runtime.run(new AbortController().signal, (e) => {
    if (e.type === "activity") {
      activities.push({ toolName: e.activity.toolName, status: e.activity.status });
    } else if (e.type === "file_change") {
      fileChanges.push({ path: e.change.path, toolCallId: e.change.toolCallId });
    }
  });

  assertEqual(result.status, "completed", "task completed");
  assertEqual(result.results[0].toolUseCount, 1, "tool use counted");
  assert(activities.some((a) => a.toolName === "write" && a.status === "running"), "activity running forwarded");
  assert(activities.some((a) => a.toolName === "write" && a.status === "completed"), "activity completed forwarded");
  assert(fileChanges.length >= 1, "file_change forwarded through the runtime event");
  assertEqual(fileChanges[0].path, "runtime-out.txt", "change path preserved");
  assertEqual(fileChanges[0].toolCallId, "nested-write-1", "change toolCallId preserved");
  assertEqual(result.activities.length, 1, "task activities include the write");

  await runtime.dispose();
});

await run("chain: {previous} substituted per step, steps 1-based, stops on failure", async () => {
  provider.scripts.length = 0;
  provider.calls.length = 0;
  provider.scripts.push(
    { kind: "message", text: "step one output", stopReason: "stop" },
    { kind: "message", text: "step two output", stopReason: "stop" },
  );

  const spec = makeSpec({
    mode: "chain",
    groupMode: "chain",
    items: [
      makeReadyItem({ index: 0, prompt: "first step" }),
      makeReadyItem({ index: 1, prompt: "next: {previous}", model: { provider: "faux", modelId: "faux-chain-model" } }),
    ],
  });
  const input = makeInputMock();
  const runtime = new AgentTaskRuntime({ spec, input: input.router });
  const result = await runtime.run(new AbortController().signal, () => {});

  assertEqual(result.status, "completed", "chain completed");
  assertEqual(result.results.length, 2, "two results");
  assertEqual(result.results[0].step, 1, "first step is 1-based");
  assertEqual(result.results[1].step, 2, "second step is 2-based");
  assertEqual(result.finalOutput, "step two output", "final output is the last step's");
  assertEqual(provider.calls.length, 2, "two provider calls");
  assertEqual(userMessageText(provider.calls[0]), "first step", "first prompt verbatim");
  assert(userMessageText(provider.calls[1]).includes("step one output"), "{previous} substituted with the prior output");
  assertEqual(provider.calls[1].model.id, "faux-chain-model", "second step uses its own frozen model");

  await runtime.dispose();
});

await run("chain: fails at a step; later steps never run", async () => {
  provider.scripts.length = 0;
  provider.calls.length = 0;
  provider.scripts.push(
    { kind: "message", text: "first", stopReason: "stop" },
    { kind: "message", text: "", stopReason: "error", errorMessage: "boom" },
  );

  const spec = makeSpec({
    mode: "chain",
    groupMode: "chain",
    items: [makeReadyItem({ index: 0 }), makeReadyItem({ index: 1 }), makeReadyItem({ index: 2 })],
  });
  const input = makeInputMock();
  const runtime = new AgentTaskRuntime({ spec, input: input.router });
  const result = await runtime.run(new AbortController().signal, () => {});

  assertEqual(result.status, "failed", "task failed");
  assertEqual(result.failureReason, "api_error", "failure reason from the failed step");
  assertEqual(result.results.length, 2, "results truncated through the failed step");
  assertEqual(result.results[0].status, "completed", "first step completed");
  assertEqual(result.results[1].status, "failed", "second step failed");
  assertEqual(result.results[1].failureReason, "api_error", "second step api_error");
  assertEqual(provider.calls.length, 2, "third step never started");

  await runtime.dispose();
});

await run("chain: over-limit {previous} substitution fails the step before any session", async () => {
  provider.scripts.length = 0;
  provider.calls.length = 0;
  provider.scripts.push({ kind: "message", text: "x".repeat(1024), stopReason: "stop" });

  const spec = makeSpec({
    mode: "chain",
    groupMode: "chain",
    items: [
      makeReadyItem({ index: 0 }),
      makeReadyItem({ index: 1, prompt: `prefix ${"{previous}".repeat(80)}` }),
    ],
  });
  const input = makeInputMock();
  const runtime = new AgentTaskRuntime({ spec, input: input.router });
  const result = await runtime.run(new AbortController().signal, () => {});

  assertEqual(result.status, "failed", "task failed");
  assertEqual(result.results[1].failureReason, "prompt_too_large", "substituted prompt over the byte cap");
  assertEqual(provider.calls.length, 1, "second session never started");

  await runtime.dispose();
});

await run("rejected item: frozen preflight failure, no session created", async () => {
  provider.scripts.length = 0;
  provider.calls.length = 0;

  const spec = makeSpec({ items: [makeRejectedItem()] });
  const input = makeInputMock();
  const runtime = new AgentTaskRuntime({ spec, input: input.router });
  const result = await runtime.run(new AbortController().signal, () => {});

  assertEqual(result.status, "failed", "task failed");
  assertEqual(result.failureReason, "unknown_agent", "frozen failure reason");
  assertEqual(result.results.length, 1, "one result");
  assertEqual(result.results[0].status, "failed", "result failed");
  assertEqual(result.results[0].agentSource, "unknown", "rejected result has no agent source");
  assertEqual(provider.calls.length, 0, "no provider call (no session)");

  await runtime.dispose();
});

await run("empty items: invalid_parameters without a session", async () => {
  provider.scripts.length = 0;
  provider.calls.length = 0;

  const spec = makeSpec({ items: [] });
  const input = makeInputMock();
  const runtime = new AgentTaskRuntime({ spec, input: input.router });
  const result = await runtime.run(new AbortController().signal, () => {});

  assertEqual(result.status, "failed", "task failed");
  assertEqual(result.failureReason, "invalid_parameters", "invalid_parameters");
  assertEqual(provider.calls.length, 0, "no provider call");

  await runtime.dispose();
});

await run("defensive model resolution: frozen model missing from the own registry fails closed", async () => {
  provider.scripts.length = 0;
  provider.calls.length = 0;

  const spec = makeSpec({
    items: [makeReadyItem({ model: { provider: "nope", modelId: "missing" } })],
  });
  const input = makeInputMock();
  const runtime = new AgentTaskRuntime({ spec, input: input.router });
  const result = await runtime.run(new AbortController().signal, () => {});

  assertEqual(result.status, "failed", "task failed");
  assertEqual(result.failureReason, "model_not_found", "model_not_found");
  assertEqual(provider.calls.length, 0, "no provider call");

  await runtime.dispose();
});

await run("max_turns: armed at turn_end and fired at the next turn_start", async () => {
  provider.scripts.length = 0;
  provider.calls.length = 0;
  // Tool calls force the loop to intend another turn; plain text would end the
  // agent loop without a turn_start (same script shape as subagent-runner's
  // maxTurns test).
  provider.scripts.push(
    {
      kind: "message",
      text: "one",
      stopReason: "stop",
      toolCall: { name: "read", id: "tc-1", args: { path: "missing-read-1.txt" } },
    },
    {
      kind: "message",
      text: "two",
      stopReason: "stop",
      toolCall: { name: "read", id: "tc-2", args: { path: "missing-read-2.txt" } },
    },
    { kind: "message", text: "three", stopReason: "stop" },
  );

  const spec = makeSpec({ items: [makeReadyItem({ maxTurns: 2 })] });
  const input = makeInputMock();
  const runtime = new AgentTaskRuntime({ spec, input: input.router });
  const result = await runtime.run(new AbortController().signal, () => {});

  assertEqual(result.status, "failed", "task failed");
  assertEqual(result.failureReason, "max_turns", "max_turns");
  assertEqual(result.results[0].failureReason, "max_turns", "result max_turns");

  await runtime.dispose();
});

await run("abort: run signal cancellation settles as cancelled", async () => {
  provider.scripts.length = 0;
  provider.calls.length = 0;
  provider.pendingHangs.length = 0;
  provider.scripts.push({ kind: "hang", streamText: "partial", respondToAbort: true });

  const spec = makeSpec({ items: [makeReadyItem()] });
  const input = makeInputMock();
  const runtime = new AgentTaskRuntime({ spec, input: input.router });
  const controller = new AbortController();
  const runPromise = runtime.run(controller.signal, () => {});
  await waitFor(() => provider.calls.length === 1, 20000, "prompt started");
  controller.abort();
  const result = await runPromise;

  assertEqual(result.status, "cancelled", "task cancelled");
  assertEqual(result.results[0].status, "aborted", "result aborted");
  assertEqual(result.results[0].failureReason, "aborted", "aborted reason");
  assertEqual(provider.calls[0].endedAt !== undefined, true, "nested stream ended");

  await runtime.dispose();
});

await run("abort: runtime.abort() settles as cancelled", async () => {
  provider.scripts.length = 0;
  provider.calls.length = 0;
  provider.pendingHangs.length = 0;
  provider.scripts.push({ kind: "hang", streamText: "partial", respondToAbort: true });

  const spec = makeSpec({ items: [makeReadyItem()] });
  const input = makeInputMock();
  const runtime = new AgentTaskRuntime({ spec, input: input.router });
  const runPromise = runtime.run(new AbortController().signal, () => {});
  await waitFor(() => provider.calls.length === 1, 20000, "prompt started");
  runtime.abort();
  const result = await runPromise;

  assertEqual(result.status, "cancelled", "task cancelled");
  assertEqual(result.results[0].status, "aborted", "result aborted");

  await runtime.dispose();
});

await run("dispose: cancels the run, idempotent, releases the runtime's own context", async () => {
  provider.scripts.length = 0;
  provider.calls.length = 0;
  provider.pendingHangs.length = 0;
  provider.scripts.push({ kind: "hang", streamText: "partial", respondToAbort: true });

  const spec = makeSpec({ items: [makeReadyItem()] });
  const input = makeInputMock();
  const runtime = new AgentTaskRuntime({ spec, input: input.router });
  const runPromise = runtime.run(new AbortController().signal, () => {});
  await waitFor(() => provider.calls.length === 1, 20000, "prompt started");

  const disposePromise = runtime.dispose();
  const result = await runPromise;
  await disposePromise;

  assertEqual(result.status, "cancelled", "dispose settles the run as cancelled");
  assertEqual(result.results[0].status, "aborted", "result aborted");
  assertEqual(runtime.dispose(), disposePromise, "dispose is idempotent and returns the same promise");
  assertEqual(provider.calls[0].endedAt !== undefined, true, "nested stream ended");
});

await run("disposed at entry: a disposed runtime never starts a session", async () => {
  provider.scripts.length = 0;
  provider.calls.length = 0;

  const spec = makeSpec({ items: [makeReadyItem()] });
  const input = makeInputMock();
  const runtime = new AgentTaskRuntime({ spec, input: input.router });
  await runtime.dispose();
  const result = await runtime.run(new AbortController().signal, () => {});

  assertEqual(result.status, "cancelled", "task cancelled");
  assertEqual(result.results[0].status, "aborted", "result aborted");
  assertEqual(result.results[0].failureReason, "aborted", "aborted reason");
  assertEqual(provider.calls.length, 0, "no session started");

  await runtime.dispose();
});

await run("ownership: parent backend dispose does not affect the task; runtime disposes exactly its own backend", async () => {
  provider.scripts.length = 0;
  provider.calls.length = 0;
  provider.pendingHangs.length = 0;
  provider.scripts.push({ kind: "hang", streamText: "partial", respondToAbort: true });

  // A parent ProjectExecutionContext with a REAL observable backend, created
  // through the real factory (WSL + fake distro resolver/backend factory, the
  // established execution-context.test.ts pattern). The runtime never receives
  // this context: it builds its own from the frozen spec.
  const parentState = { disposed: 0 };
  const parentBackend: ExecutionBackend = {
    paths: {
      pathStyle: "posix",
      homeDir: "/home/u",
      resolvePath: (input: string, cwd: string) => (input.startsWith("/") ? input : join(cwd, input)),
    },
    runtimeEnvironment: { platform: "linux", osName: "WSL2 (Ubuntu-22.04)", shell: { kind: "wsl", path: "wsl.exe" } },
    getCwd: () => "/home/u/repo",
    dispose: async () => {
      parentState.disposed++;
    },
  };
  const parentFactory: typeof createWslExecutionBackend = async () => parentBackend;
  const fakeResolver = new FakeResolver({
    distros: [{ name: "Ubuntu-22.04", state: "Running", version: 2, isDefault: true }],
    home: "/home/u",
    automount: { enabled: true, root: "/mnt" },
  });
  const parentPhysical = mkdtempSync(join(tmpdir(), "pix-agent-task-parent-"));
  const converter = new WslPathConverter({
    distro: "Ubuntu-22.04",
    home: "/home/u",
    automountRoot: "/mnt",
    automountEnabled: true,
  });
  const parentLocation: ProjectLocation = {
    path: converter.windowsToLinux(parentPhysical),
    physicalPath: parentPhysical,
    name: "parent-wsl",
    environment: { kind: "wsl", distro: "Ubuntu-22.04" },
  };
  const parentContext = await createProjectExecutionContext(parentLocation, {
    resolver: fakeResolver,
    createBackend: parentFactory,
  });
  assert(parentContext.executionBackend === parentBackend, "parent context owns the fake backend");

  // The runtime's own context: injected fake with an observable backend so the
  // test can assert the runtime creates and disposes exactly one backend.
  const ownState = { createCalls: 0, disposeCalls: 0 };
  const ownBackend: ExecutionBackend = {
    paths: {
      pathStyle: "win32",
      homeDir: "C:\\Users\\test",
      resolvePath: (input: string, cwd: string) => input,
    },
    runtimeEnvironment: { platform: "win32", osName: "Windows 11", shell: { kind: "powershell" } },
    getCwd: () => PROJECT_CWD,
    dispose: async () => {
      ownState.disposeCalls++;
    },
  };
  // The spec must be in the injection closures' lexical scope (declared before
  // the factories, outside the try block).
  const spec = makeSpec({ items: [makeReadyItem()] });
  const input = makeInputMock();
  const restore = __setAgentTaskRuntimeContextFactoriesForTests(
    async () => {
      ownState.createCalls++;
      return {
        location: spec.project,
        logicalCwd: spec.project.path,
        physicalCwd: spec.project.physicalPath,
        executionBackend: ownBackend,
        isWsl: false,
      };
    },
    async (context) => {
      await disposeProjectExecutionContext(context);
    },
  );

  try {
    const runtime = new AgentTaskRuntime({ spec, input: input.router });
    const runPromise = runtime.run(new AbortController().signal, () => {});
    await waitFor(() => provider.calls.length === 1, 20000, "prompt started");

    // The parent switches/closes mid-run: its backend is disposed. The task
    // keeps running because it never borrowed the parent context.
    await disposeProjectExecutionContext(parentContext);
    assertEqual(parentState.disposed, 1, "parent backend disposed by the parent owner");

    releaseHangStream(provider.pendingHangs[0].stream);
    const result = await runPromise;
    assertEqual(result.status, "completed", "task completed after the parent backend was disposed");
    assertEqual(ownState.createCalls, 1, "runtime created exactly one own context");
    assertEqual(ownState.disposeCalls, 1, "runtime disposed exactly its own backend at runtime end");

    // dispose() after the run is a no-op for the context (already released).
    await runtime.dispose();
    assertEqual(ownState.disposeCalls, 1, "no double dispose of the runtime's own backend");
  } finally {
    restore();
    rmSync(parentPhysical, { recursive: true, force: true });
  }
});

await run("input routing: enqueue shape, resolveInput continues the turn, cancelInput cancels", async () => {
  provider.scripts.length = 0;
  provider.calls.length = 0;

  const spec = makeSpec({ items: [makeReadyItem()] });
  const input = makeInputMock();
  const runtime = new AgentTaskRuntime({ spec, input: input.router });

  // 1. The model asks a question; the runtime enqueues and awaits the answer.
  provider.scripts.push(
    {
      kind: "message",
      text: "",
      stopReason: "stop",
      toolCall: {
        name: "request_user_input",
        id: "input-tc-1",
        args: {
          questions: [{ id: "q1", header: "Header", question: "Question?", options: [{ label: "A" }, { label: "B" }] }],
        },
      },
    },
    { kind: "message", text: "answered", stopReason: "stop" },
  );
  const runPromise = runtime.run(new AbortController().signal, () => {});
  await waitFor(() => input.state.enqueued.length === 1, 20000, "input enqueued");
  assertEqual(input.state.enqueued[0].taskId, spec.taskId, "enqueue carries the taskId");
  assertEqual(input.state.enqueued[0].generation, 0, "1.4.1 tasks always route on generation 0");
  assertEqual(input.state.enqueued[0].request.questions.length, 1, "enqueue carries the request");
  assert(input.state.enqueued[0].signal instanceof AbortSignal, "enqueue carries an AbortSignal");

  const answered = await runtime.resolveInput(input.state.enqueued[0].request.id, {
    id: input.state.enqueued[0].request.id,
    answers: { q1: "A" },
  });
  assertEqual(answered, true, "resolveInput delivered");
  const firstResult = await runPromise;
  assertEqual(firstResult.status, "completed", "turn continued after the answer");
  assertEqual(firstResult.finalOutput, "answered", "final output after answering");

  // 2. cancelInput settles the wait as a cancelled response.
  provider.scripts.length = 0;
  provider.scripts.push(
    {
      kind: "message",
      text: "",
      stopReason: "stop",
      toolCall: {
        name: "request_user_input",
        id: "input-tc-2",
        args: {
          questions: [{ id: "q1", header: "Header", question: "Question?", options: [{ label: "A" }, { label: "B" }] }],
        },
      },
    },
    { kind: "message", text: "after cancel", stopReason: "stop" },
  );
  const runPromise2 = runtime.run(new AbortController().signal, () => {});
  await waitFor(() => input.state.enqueued.length === 2, 20000, "second input enqueued");
  const cancelled = await runtime.cancelInput(input.state.enqueued[1].request.id);
  assertEqual(cancelled, true, "cancelInput settled");
  const secondResult = await runPromise2;
  assertEqual(secondResult.status, "completed", "turn continued after the cancel");
  assertEqual(secondResult.finalOutput, "after cancel", "final output after cancelling the input");

  // 3. Unknown request ids are rejected, never resolved.
  assertEqual(runtime.resolveInput("no-such-request", { id: "no-such-request", answers: {} }), false, "unknown request rejected");
  assertEqual(runtime.cancelInput("no-such-request"), false, "unknown cancel rejected");

  await runtime.dispose();
});

await run("memory mode: no checkpoint events emitted without a taskSessionDir", async () => {
  provider.scripts.length = 0;
  provider.calls.length = 0;
  provider.scripts.push({ kind: "message", text: "done", stopReason: "stop" });

  const spec = makeSpec({ items: [makeReadyItem()] });
  const input = makeInputMock();
  const runtime = new AgentTaskRuntime({ spec, input: input.router });
  const types: string[] = [];
  const result = await runtime.run(new AbortController().signal, (e) => {
    types.push(e.type);
  });

  assertEqual(result.status, "completed", "task completed");
  assert(types.includes("checkpoint") === false, "no checkpoint events without a taskSessionDir (in-memory contract)");

  await runtime.dispose();
});

await run("disk session: final message checkpoint carries the leaf, assistant_finalized fires, item_end keeps sessionLeafId null", async () => {
  provider.scripts.length = 0;
  provider.calls.length = 0;
  provider.scripts.push(
    {
      kind: "message",
      text: "",
      stopReason: "stop",
      toolCall: { name: "write", id: "g10-write-1", args: { path: "g10-out.txt", content: "boom" } },
    },
    { kind: "message", text: "final answer", stopReason: "stop" },
  );

  const taskSessionDir = mkdtempSync(join(tmpdir(), "pix-agent-task-sessions-"));
  try {
    const spec = makeSpec({ items: [makeReadyItem()] });
    const input = makeInputMock();
    const runtime = new AgentTaskRuntime({ spec, input: input.router, taskSessionDir });
    const checkpoints: TaskCheckpoint[] = [];
    const finalized: string[] = [];
    const result = await runtime.run(new AbortController().signal, (e) => {
      if (e.type === "checkpoint") {
        checkpoints.push(e.checkpoint);
      } else if (e.type === "assistant_finalized") {
        finalized.push(e.entryId);
      }
    });

    assertEqual(result.status, "completed", "task completed");
    assert(finalized.length >= 1, "assistant_finalized emitted for every finalized assistant message");
    const messageLeaf = finalized[finalized.length - 1];
    assert(messageLeaf !== undefined && messageLeaf !== "", "finalized entry id is a real leaf id");
    assert(
      checkpoints.some((c) => c.sessionFileName !== null && c.sessionLeafId === messageLeaf),
      "a checkpoint carries the final message leaf as sessionLeafId",
    );
    const itemStart = checkpoints.find((c) => c.activeItemIndex === 0 && c.sessionFileName !== null);
    assert(itemStart !== undefined, "item_start checkpoint emitted with the item's session file");
    const itemEnd = checkpoints.find((c) => c.sessionFileName === null);
    assert(itemEnd !== undefined, "item_end checkpoint emitted");
    if (itemEnd !== undefined) {
      assertEqual(itemEnd.sessionLeafId, null, "item_end checkpoint keeps sessionLeafId null (resumer contract)");
    }

    await runtime.dispose();
  } finally {
    rmSync(taskSessionDir, { recursive: true, force: true });
  }
});

await run("resume: folded prefix with a failed item breaks before consuming the prepared session, which the run releases", async () => {
  provider.scripts.length = 0;
  provider.calls.length = 0;

  const taskSessionDir = mkdtempSync(join(tmpdir(), "pix-agent-task-sessions-"));
  try {
    const spec = makeSpec({
      mode: "chain",
      groupMode: "chain",
      items: [makeReadyItem({ index: 0 }), makeReadyItem({ index: 1 })],
    });
    // The seed's transcript: the resumer creates the next item's session file
    // (header + recovery note) before building the seed.
    const sessionFileName = "resume-session.jsonl";
    const timestamp = new Date().toISOString();
    writeFileSync(
      join(taskSessionDir, sessionFileName),
      [
        JSON.stringify({ type: "session", version: 3, id: "resume-session-1", timestamp, cwd: PROJECT_CWD }),
        JSON.stringify({
          type: "custom_message",
          customType: "pix-task-resume",
          content: "recovery note",
          display: true,
          details: { generation: 0 },
          id: "resume-note-1",
          parentId: "resume-session-1",
          timestamp,
        }),
      ].join("\n") + "\n",
      "utf-8",
    );

    const input = makeInputMock();
    const runtime = new AgentTaskRuntime({ spec, input: input.router, taskSessionDir });
    const failedPrefix: SubagentSingleResult = {
      id: "prefix-failed-0",
      index: 0,
      step: 1,
      agentName: "general-purpose",
      agentSource: "built-in",
      description: "A runtime test item",
      status: "failed",
      failureReason: "tool_unavailable",
      errorMessage: "Requested tool(s) not available: run_background.",
      finalOutput: "",
      outputTruncated: false,
      originalOutputBytes: 0,
      toolUseCount: 0,
      activities: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, turns: 0 },
      model: "faux/faux-model",
      durationMs: 10,
      startedAt: Date.now() - 10,
      endedAt: Date.now(),
    };

    await runtime.prepareResume({
      checkpoint: {
        taskId: spec.taskId,
        generation: 0,
        seq: 0,
        activeItemIndex: 1,
        sessionFileName,
        sessionLeafId: "resume-note-1",
        openToolCalls: [],
        workspaceFingerprint: { isGit: false, observedFileHashes: {} },
        ts: Date.now(),
      },
      decision: { action: "continue", confirmWorkspaceChanges: true },
      effectiveModel: { provider: "faux", modelId: "faux-model" },
      injectNote: "recovery note",
      priorResults: [failedPrefix],
    });

    const internal = runtime as unknown as { _preparedSession: unknown; _preparedMcpAdapter: unknown };
    assert(internal._preparedSession !== undefined, "prepareResume created the idle nested session");
    assert(internal._preparedMcpAdapter !== undefined, "prepareResume created the prepared MCP adapter");

    const result = await runtime.run(new AbortController().signal, () => {});

    assertEqual(result.status, "failed", "a chain with a failed folded prefix converges to failed without a new turn");
    assertEqual(result.results.length, 1, "the seeded failed prefix stays the only result");
    assertEqual(provider.calls.length, 0, "no model turn (the run breaks before the resume item)");
    assert(internal._preparedSession === undefined, "unconsumed prepared session released by the run's end");
    assert(internal._preparedMcpAdapter === undefined, "unconsumed prepared MCP adapter released by the run's end");

    await runtime.dispose();
    assert(internal._preparedSession === undefined, "prepared session stays released after dispose");
  } finally {
    rmSync(taskSessionDir, { recursive: true, force: true });
  }
});

await run("prepareResume applies appendSystemPrompt and schema prompt last", async () => {
  provider.scripts.length = 0;
  provider.calls.length = 0;
  provider.scripts.push({
    kind: "message",
    text: "",
    stopReason: "stop",
    toolCall: { name: "submit_workflow_result", id: "submit-resume-1", args: { answer: { value: 7 } } },
  });
  const extra = "## Workflow artifacts\n### reviews\n```json\n{\"n\":1}\n```";
  const schema = {
    type: "object",
    properties: { answer: { type: "object" } },
    required: ["answer"],
    additionalProperties: false,
  };
  const item = makeReadyItem({
    outputSchema: schema,
    appendSystemPrompt: extra,
  });
  const taskSessionDir = mkdtempSync(join(tmpdir(), "pix-agent-task-sessions-"));
  try {
    const spec = makeSpec({ items: [item] });
    const sessionFileName = "resume-session.jsonl";
    const timestamp = new Date().toISOString();
    writeFileSync(
      join(taskSessionDir, sessionFileName),
      [
        JSON.stringify({ type: "session", version: 3, id: "resume-session-1", timestamp, cwd: PROJECT_CWD }),
        JSON.stringify({
          type: "custom_message",
          customType: "pix-task-resume",
          content: "recovery note",
          display: true,
          details: { generation: 0 },
          id: "resume-note-1",
          parentId: "resume-session-1",
          timestamp,
        }),
      ].join("\n") + "\n",
      "utf-8",
    );
    const runtime = new AgentTaskRuntime({ spec, input: makeInputMock().router, taskSessionDir });
    await runtime.prepareResume({
      checkpoint: {
        taskId: spec.taskId,
        generation: 0,
        seq: 0,
        activeItemIndex: 0,
        sessionFileName,
        sessionLeafId: "resume-note-1",
        openToolCalls: [],
        workspaceFingerprint: { isGit: false, observedFileHashes: {} },
        ts: Date.now(),
      },
      decision: { action: "continue", confirmWorkspaceChanges: true },
      effectiveModel: { provider: "faux", modelId: "faux-model" },
      injectNote: "recovery note",
      priorResults: [],
    });
    const result = await runtime.run(new AbortController().signal, () => {});
    assertEqual(result.status, "completed", "resumed schema child with artifacts append completed");
    assertEqual(provider.calls.length, 1, "resume path issued one provider call");
    const systemPrompt = provider.calls[0].context.systemPrompt ?? "";
    const agentIdx = systemPrompt.indexOf("You are a test agent.");
    const extraIdx = systemPrompt.indexOf(extra);
    const schemaPrompt = schemaChildCompletionPrompt({
      type: "object",
      properties: { answer: { type: "object" } },
      required: ["answer"],
      additionalProperties: false,
    });
    const schemaIdx = systemPrompt.indexOf(schemaPrompt);
    assert(agentIdx >= 0, "resume agent systemPrompt is present");
    assert(extraIdx > agentIdx, "resume extraAppend follows the agent systemPrompt");
    assert(schemaIdx > extraIdx, "resume schema completion contract is last");
    await runtime.dispose();
  } finally {
    rmSync(taskSessionDir, { recursive: true, force: true });
  }
});

await run("nestedSystemPromptOverride: extraAppend then schema completion contract last", async () => {
  provider.scripts.length = 0;
  provider.calls.length = 0;
  provider.scripts.push({
    kind: "message",
    text: "",
    stopReason: "stop",
    toolCall: { name: "submit_workflow_result", id: "submit-order-1", args: { answer: { value: 1 } } },
  });
  const extra = "## Workflow artifacts\n### reviews\n```json\n{\"n\":1}\n```";
  const schema = {
    type: "object",
    properties: { answer: { type: "object" } },
    required: ["answer"],
    additionalProperties: false,
  };
  const item = makeReadyItem({
    outputSchema: schema,
    appendSystemPrompt: extra,
  });
  const runtime = new AgentTaskRuntime({ spec: makeSpec({ items: [item] }), input: makeInputMock().router });
  const result = await runtime.run(new AbortController().signal, () => {});
  assertEqual(result.status, "completed", "schema child with artifacts append completed");
  assertEqual(provider.calls.length, 1, "one provider call");
  const systemPrompt = provider.calls[0].context.systemPrompt ?? "";
  const agentIdx = systemPrompt.indexOf("You are a test agent.");
  const extraIdx = systemPrompt.indexOf(extra);
  const schemaPrompt = schemaChildCompletionPrompt({
    type: "object",
    properties: { answer: { type: "object" } },
    required: ["answer"],
    additionalProperties: false,
  });
  const schemaIdx = systemPrompt.indexOf(schemaPrompt);
  assert(agentIdx >= 0, "agent systemPrompt is present");
  assert(extraIdx > agentIdx, "extraAppend follows the agent systemPrompt");
  assert(schemaIdx > extraIdx, "schema completion contract is last");
  await runtime.dispose();
});

await run("appendSystemPrompt does not count against the 64KB delegated prompt cap", async () => {
  provider.scripts.length = 0;
  provider.calls.length = 0;
  provider.scripts.push({ kind: "message", text: "ok", stopReason: "stop" });
  const huge = "x".repeat(MAX_DELEGATED_PROMPT_BYTES + 1);
  const item = makeReadyItem({ prompt: "short instruction", appendSystemPrompt: huge });
  const runtime = new AgentTaskRuntime({ spec: makeSpec({ items: [item] }), input: makeInputMock().router });
  const result = await runtime.run(new AbortController().signal, () => {});
  assertEqual(result.status, "completed", "large appendSystemPrompt does not trip the 64KB prompt cap");
  assertEqual(provider.calls.length, 1, "session started");
  assertEqual(userMessageText(provider.calls[0]), "short instruction", "user message is the short prompt only");
  assert((provider.calls[0].context.systemPrompt ?? "").includes(huge.slice(0, 32)), "append is in the system prompt");
  await runtime.dispose();
});

await run("disk session: abort does not emit item_end or item_result", async () => {
  provider.scripts.length = 0;
  provider.calls.length = 0;
  provider.pendingHangs.length = 0;
  provider.scripts.push({ kind: "hang", streamText: "partial", respondToAbort: true });

  const taskSessionDir = mkdtempSync(join(tmpdir(), "pix-agent-task-abort-cp-"));
  try {
    const spec = makeSpec({ items: [makeReadyItem()] });
    const input = makeInputMock();
    const runtime = new AgentTaskRuntime({ spec, input: input.router, taskSessionDir });
    const checkpoints: TaskCheckpoint[] = [];
    let itemResults = 0;
    const controller = new AbortController();
    const runPromise = runtime.run(controller.signal, (e) => {
      if (e.type === "checkpoint") {
        checkpoints.push(e.checkpoint);
      } else if (e.type === "item_result") {
        itemResults += 1;
      }
    });
    await waitFor(() => provider.calls.length === 1, 20000, "prompt started");
    controller.abort();
    const result = await runPromise;
    assertEqual(result.status, "cancelled", "task cancelled");
    assertEqual(itemResults, 0, "aborted item does not emit item_result");
    assert(
      checkpoints.every((c) => c.sessionFileName !== null),
      "abort does not emit item_end (sessionFileName=null)",
    );
    await runtime.dispose();
  } finally {
    rmSync(taskSessionDir, { recursive: true, force: true });
  }
});

// ============================================================================

rmSync(AGENT_DIR, { recursive: true, force: true });
rmSync(PROJECT_CWD, { recursive: true, force: true });

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
