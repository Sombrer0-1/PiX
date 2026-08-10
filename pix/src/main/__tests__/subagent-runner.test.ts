/**
 * SubagentRunner + `agent` tool tests (S2).
 *
 * Uses a faux pi-ai api provider (registerApiProvider) so every nested session
 * runs the REAL createAgentSession / bindExtensions / prompt machinery with a
 * controllable LLM stream; prototype patches record lifecycle calls; a
 * hand-rolled fake clock bounds the real timeout constants without changing
 * production code.
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
  DefaultResourceLoader,
  ModelRegistry,
  loadAgents,
  type AgentExecutionMode,
  type LoadAgentsResult,
  type RequestUserInputRequest,
  type RequestUserInputResponse,
} from "@earendil-works/pi-coding-agent";
import { McpAdapter } from "pi-mcp-adapter";
import { isSubagentDetails } from "../../shared/subagent-types.js";
import type { SubagentDetails, SubagentUsage } from "../../shared/subagent-types.js";
import {
  ABORT_TIMEOUT_MS,
  MAX_ACTIVE_SUBAGENTS,
  MAX_DELEGATED_PROMPT_BYTES,
  MAX_ERROR_MESSAGE_BYTES,
  MAX_PARALLEL_TASKS,
  MAX_TASK_OUTPUT_BYTES,
  NESTED_CLEANUP_TIMEOUT_MS,
  NESTED_STARTUP_TIMEOUT_MS,
  SubagentRunner,
} from "../subagent/subagent-runner.js";
import { createSubagentToolDefinition, SUBAGENT_TOOL_NAME } from "../subagent/subagent-tool.js";
import type { SubagentExecutionContext, SubagentToolHost } from "../subagent/types.js";

// ============================================================================
// Test harness (matches subagent-types.test.ts style)
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

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
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
    "faux-a": {
      baseUrl: "http://localhost:2",
      api: "faux-api",
      apiKey: "ka",
      models: [{ id: "shared-id", name: "Shared A", reasoning: false, input: ["text"], cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 1000 }],
    },
    "faux-b": {
      baseUrl: "http://localhost:3",
      api: "faux-api",
      apiKey: "kb",
      models: [{ id: "shared-id", name: "Shared B", reasoning: false, input: ["text"], cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 1000 }],
    },
    // A custom provider whose apiKey references a missing env var: validation
    // accepts the non-empty string, but hasConfiguredAuth() is false, so the
    // bare-id auth fail-closed path resolves via getAll() and then fails on
    // hasConfiguredAuth.
    noauth: {
      baseUrl: "http://localhost:9",
      api: "faux-api",
      apiKey: "$PIX_TEST_MISSING_KEY",
      models: [{ id: "unique-bare-id", name: "Bare", reasoning: false, input: ["text"], cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 1000 }],
    },
  },
};

function writeModelsJson(): void {
  writeFileSync(join(AGENT_DIR, "models.json"), JSON.stringify(MODELS_JSON, null, 2), "utf-8");
}

writeModelsJson();

function writeAgent(dir: string, filename: string, frontmatter: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), `---\n${frontmatter}\n---\n\n${body}`, "utf-8");
}

function writeUserAgent(filename: string, frontmatter: string, body = "You are a test agent."): void {
  writeAgent(AGENTS_DIR, filename, frontmatter, body);
}

function writeProjectAgent(filename: string, frontmatter: string, body = "You are a project test agent."): void {
  writeAgent(join(PROJECT_CWD, ".pi", "agents"), filename, frontmatter, body);
}

function clearAgents(): void {
  rmSync(AGENTS_DIR, { recursive: true, force: true });
  mkdirSync(AGENTS_DIR, { recursive: true });
  rmSync(join(PROJECT_CWD, ".pi"), { recursive: true, force: true });
}

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

// ============================================================================
// Fake clock (hand-rolled; only timers created through the faked globals are
// affected, so real microtasks/IO keep flowing between ticks).
// ============================================================================

interface FakeClock {
  uninstall: () => void;
  tick: (ms: number) => Promise<void>;
}

function installFakeClock(): FakeClock {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const realDateNow = Date.now;
  let now = realDateNow();
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();

  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    const id = nextId++;
    timers.set(id, { at: now + (ms ?? 0), fn });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: unknown) => {
    timers.delete(Number(id));
  }) as typeof clearTimeout;
  Date.now = () => now;

  const drainTimers = async (): Promise<void> => {
    for (;;) {
      const due = Array.from(timers.entries())
        .filter(([, t]) => t.at <= now)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
      if (due.length === 0) {
        return;
      }
      for (const [id, timer] of due) {
        timers.delete(id);
        timer.fn();
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
  };

  return {
    uninstall: () => {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
      Date.now = realDateNow;
      timers.clear();
    },
    tick: async (ms: number) => {
      now += ms;
      await drainTimers();
    },
  };
}

/** Let pending microtasks settle so timers created by promise continuations are registered. */
async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
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
// Runner harness
// ============================================================================

interface Harness {
  ctx: SubagentExecutionContext;
  registry: ModelRegistry;
  authStorage: AuthStorage;
  usageSink: SubagentUsage[];
  inputRequests: Array<{ request: RequestUserInputRequest; signal: AbortSignal | undefined }>;
  parentRuntime: {
    model: Model<Api> | undefined;
    thinkingLevel: ThinkingLevel;
    executionMode: AgentExecutionMode;
    verificationGate: boolean;
  };
  requestUserInputHandler: (request: RequestUserInputRequest, signal?: AbortSignal) => Promise<RequestUserInputResponse>;
  isWsl: boolean;
}

function makeHarness(overrides: Partial<Harness> = {}): Harness {
  const authStorage = AuthStorage.create(join(AGENT_DIR, "auth.json"));
  const registry = ModelRegistry.create(authStorage, join(AGENT_DIR, "models.json"));
  // Register the faux api on the SAME pi-ai instance the coding-agent dist
  // uses (registry.registerProvider wires through its own api-registry), so
  // nested session streamFn calls dispatch to the faux provider.
  registry.registerProvider("faux", { api: "faux-api", streamSimple: fauxStream });
  const parentModel = registry.find("faux", "faux-model");
  const inputRequests: Array<{ request: RequestUserInputRequest; signal: AbortSignal | undefined }> = [];
  const usageSink: SubagentUsage[] = [];

  const harness: Harness = {
    ctx: undefined as unknown as SubagentExecutionContext,
    registry,
    authStorage,
    usageSink,
    inputRequests,
    parentRuntime: {
      model: parentModel,
      thinkingLevel: "high",
      executionMode: "approval",
      verificationGate: true,
    },
    requestUserInputHandler: async (request) => ({ id: request.id, cancelled: false, answers: { allow_project_agents: "允许" } }),
    isWsl: false,
    ...overrides,
  };

  harness.ctx = {
    physicalCwd: PROJECT_CWD,
    logicalCwd: PROJECT_CWD,
    agentDir: AGENT_DIR,
    executionBackend: undefined,
    runtimeEnvironmentOverride: undefined,
    authStorage: harness.authStorage,
    modelRegistry: harness.registry,
    isWsl: harness.isWsl,
    getLoadedAgents: () => loadAgents({ cwd: PROJECT_CWD, agentDir: AGENT_DIR, includeBuiltIns: true }),
    getParentRuntime: () => harness.parentRuntime,
    requestUserInput: (request, signal) => {
      harness.inputRequests.push({ request, signal });
      return harness.requestUserInputHandler(request, signal);
    },
    recordAuxiliaryUsage: (usage) => {
      harness.usageSink.push(usage);
    },
  };
  return harness;
}

function makeRunner(harness: Harness): SubagentRunner {
  return new SubagentRunner(harness.ctx);
}

/** Execute a tool definition; the ctx argument is unused by the agent tool. */
function executeTool(
  tool: ReturnType<typeof createSubagentToolDefinition>,
  toolCallId: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
  onUpdate?: (update: { content: Array<{ type: string; text?: string }>; details: SubagentDetails }) => void,
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

await run("preflight: unknown agent fails side-effect-free", async () => {
  clearAgents();
  const harness = makeHarness();
  const runner = makeRunner(harness);
  provider.scripts.length = 0;
  provider.calls.length = 0;

  const details = await runner.run(
    { mode: "single", agentScope: "user", tasks: [{ subagent_type: "no-such-agent", prompt: "do something" }] },
    undefined,
  );
  assert(isSubagentDetails(details), "details passes the shared guard");
  assertEqual(details.results.length, 1, "one result");
  assertEqual(details.results[0].status, "failed", "status failed");
  assertEqual(details.results[0].failureReason, "unknown_agent", "reason unknown_agent");
  assertEqual(provider.calls.length, 0, "no provider call (no session created)");
  assertEqual(harness.usageSink.length, 0, "no usage recorded");
});

await run("preflight: empty and over-limit prompts fail with prompt_too_large", async () => {
  clearAgents();
  const harness = makeHarness();
  const runner = makeRunner(harness);
  provider.calls.length = 0;

  const empty = await runner.run({ mode: "single", agentScope: "user", tasks: [{ prompt: "   " }] }, undefined);
  assertEqual(empty.results[0].failureReason, "prompt_too_large", "whitespace prompt rejected");

  const oversized = await runner.run(
    { mode: "single", agentScope: "user", tasks: [{ prompt: "x".repeat(MAX_DELEGATED_PROMPT_BYTES + 1) }] },
    undefined,
  );
  assertEqual(oversized.results[0].failureReason, "prompt_too_large", "over-limit prompt rejected");
  assertEqual(provider.calls.length, 0, "no session created for invalid prompts");
});

await run("preflight: illegal task counts fail with invalid_parameters", async () => {
  clearAgents();
  const harness = makeHarness();
  const runner = makeRunner(harness);
  provider.calls.length = 0;

  const zero = await runner.run({ mode: "parallel", agentScope: "user", tasks: [] }, undefined);
  assertEqual(zero.results[0].failureReason, "invalid_parameters", "zero tasks rejected");

  const many = await runner.run(
    { mode: "parallel", agentScope: "user", tasks: Array.from({ length: MAX_PARALLEL_TASKS + 1 }, () => ({ prompt: "t" })) },
    undefined,
  );
  assertEqual(many.results[0].failureReason, "invalid_parameters", "over-limit task count rejected");
  assertEqual(provider.calls.length, 0, "no session created");
});

await run("inherit: parent model and thinking level inherited exactly", async () => {
  clearAgents();
  const harness = makeHarness();
  const runner = makeRunner(harness);
  provider.scripts.length = 0;
  provider.calls.length = 0;
  provider.scripts.push({ kind: "message", text: "result text", stopReason: "stop" });

  const details = await runner.run({ mode: "single", agentScope: "user", tasks: [{ prompt: "delegate" }] }, undefined);
  assertEqual(details.results[0].status, "completed", "completed");
  assertEqual(provider.calls.length, 1, "one provider call");
  const call = provider.calls[0];
  assertEqual(call.model.provider, "faux", "inherited provider");
  assertEqual(call.model.id, "faux-model", "inherited model id");
  assertEqual(call.options?.reasoning, "high", "inherited thinking level");
  assertEqual(details.results[0].model, "faux/faux-model", "result model label");
  assertEqual(details.results[0].finalOutput, "result text", "final output");
});

await run("inherit: missing parent model fails with model_unavailable", async () => {
  clearAgents();
  const harness = makeHarness({
    parentRuntime: { model: undefined, thinkingLevel: "high", executionMode: "approval", verificationGate: true },
  });
  const runner = makeRunner(harness);
  provider.calls.length = 0;

  const details = await runner.run({ mode: "single", agentScope: "user", tasks: [{ prompt: "delegate" }] }, undefined);
  assertEqual(details.results[0].status, "failed", "failed");
  assertEqual(details.results[0].failureReason, "model_unavailable", "model_unavailable");
  assertEqual(provider.calls.length, 0, "no session created");
});

await run("explicit provider/modelId: split at first slash keeps embedded slashes", async () => {
  clearAgents();
  writeUserAgent("slashy.md", "name: slashy\ndescription: slashy agent\nmodel: faux/x/y");
  const harness = makeHarness();
  const runner = makeRunner(harness);
  provider.scripts.length = 0;
  provider.calls.length = 0;
  provider.scripts.push({ kind: "message", text: "ok", stopReason: "stop" });

  const details = await runner.run({ mode: "single", agentScope: "user", tasks: [{ subagent_type: "slashy", prompt: "go" }] }, undefined);
  assertEqual(details.results[0].status, "completed", "completed");
  assertEqual(provider.calls[0].model.id, "x/y", "modelId keeps its embedded slash");
  assertEqual(provider.calls[0].model.provider, "faux", "provider is the part before the first slash");
});

await run("explicit model: not found / ambiguous / auth-unavailable are fail-closed", async () => {
  clearAgents();
  const harness = makeHarness();
  const runner = makeRunner(harness);
  provider.calls.length = 0;

  writeUserAgent("missing.md", "name: missing\ndescription: missing agent\nmodel: faux/does-not-exist");
  const notFound = await runner.run({ mode: "single", agentScope: "user", tasks: [{ subagent_type: "missing", prompt: "go" }] }, undefined);
  assertEqual(notFound.results[0].failureReason, "model_not_found", "provider/modelId not found");

  writeUserAgent("amb.md", "name: amb\ndescription: amb agent\nmodel: shared-id");
  const ambiguous = await runner.run({ mode: "single", agentScope: "user", tasks: [{ subagent_type: "amb", prompt: "go" }] }, undefined);
  assertEqual(ambiguous.results[0].failureReason, "model_ambiguous", "bare id matching two providers is ambiguous");

  // Bare id resolved via getAll() with zero auth configured: fail-closed is
  // model_auth_unavailable, never a misleading model_not_found.
  writeUserAgent("noauth.md", "name: noauth\ndescription: noauth agent\nmodel: unique-bare-id");
  const noAuth = await runner.run({ mode: "single", agentScope: "user", tasks: [{ subagent_type: "noauth", prompt: "go" }] }, undefined);
  assertEqual(noAuth.results[0].failureReason, "model_auth_unavailable", "bare model with no auth fails closed");
  assertEqual(provider.calls.length, 0, "no session created for any explicit-model failure");
});

await run("detached snapshots: inherit and explicit models share no nested references", async () => {
  clearAgents();
  const harness = makeHarness();
  const runner = makeRunner(harness);
  provider.scripts.length = 0;
  provider.calls.length = 0;
  provider.scripts.push({ kind: "hang", respondToAbort: true }, { kind: "hang", respondToAbort: true });

  const registryModel = harness.registry.getAll().find((m) => m.provider === "faux" && m.id === "faux-model")!;

  // Inherit case.
  const runPromise = runner.run({ mode: "single", agentScope: "user", tasks: [{ prompt: "inherit task" }] }, undefined);
  await waitFor(() => provider.calls.length === 1, 20000, "inherit prompt started");
  const inherited = provider.calls[0].model;
  assert(inherited !== registryModel, "inherit: model identity is not inherited");
  // Mutate the registry item's nested fields after preflight; the snapshot
  // must be detached.
  registryModel.thinkingLevelMap!["high"] = "HACKED";
  registryModel.input.push("image");
  registryModel.cost.input = 999;
  assertEqual(inherited.thinkingLevelMap?.["high"], "high", "inherit: thinkingLevelMap detached from registry");
  assertEqual(inherited.input.includes("image"), false, "inherit: input array detached from registry");
  assertEqual(inherited.cost.input, 1, "inherit: cost object detached from registry");
  assert(inherited.thinkingLevelMap !== registryModel.thinkingLevelMap, "inherit: nested map is a different object");
  releaseHangStream(provider.pendingHangs[0].stream);

  // Explicit case.
  writeUserAgent("exp.md", "name: exp\ndescription: exp agent\nmodel: faux/faux-model");
  const explicitPromise = runner.run({ mode: "single", agentScope: "user", tasks: [{ subagent_type: "exp", prompt: "explicit task" }] }, undefined);
  await waitFor(() => provider.calls.length === 2, 20000, "explicit prompt started");
  const explicitModel = provider.calls[1].model;
  assert(explicitModel !== registryModel, "explicit: model identity is not inherited");
  // The explicit snapshot was copied at its own preflight, AFTER the first
  // mutation batch: it carries the mutated VALUE but no shared reference.
  assertEqual(explicitModel.thinkingLevelMap?.["high"], "HACKED", "explicit: snapshot reflects the value at capture time");
  assert(explicitModel.thinkingLevelMap !== registryModel.thinkingLevelMap, "explicit: nested map is a different object");
  // Mutate again after capture: nothing may leak into the session copy.
  registryModel.thinkingLevelMap!["high"] = "HACKED2";
  (registryModel.input as string[]).push("image2");
  assertEqual(explicitModel.thinkingLevelMap?.["high"], "HACKED", "explicit: post-capture mutation does not leak");
  assertEqual((explicitModel.input as string[]).includes("image2"), false, "explicit: input array detached from registry");
  releaseHangStream(provider.pendingHangs[0].stream);

  const runResult = await runPromise;
  const explicitResult = await explicitPromise;
  assertEqual(runResult.results[0].status, "completed", "inherit run completed");
  assertEqual(explicitResult.results[0].status, "completed", "explicit run completed");
  assert(
    harness.registry.getAll().find((m) => m.provider === "faux" && m.id === "faux-model") !== undefined,
    "registry identity unchanged after nested runs",
  );
});

await run("nested lifecycle: bindExtensions before prompt; adapter allowStdio follows isWsl", async () => {
  clearAgents();
  const harness = makeHarness();
  const runner = makeRunner(harness);
  provider.scripts.length = 0;
  provider.calls.length = 0;
  provider.scripts.push({ kind: "message", text: "ok", stopReason: "stop" });

  const order: string[] = [];
  const adapterOptions: Array<{ allowStdio: boolean | undefined }> = [];
  const origBind = AgentSession.prototype.bindExtensions;
  const origRegister = McpAdapter.prototype.register;
  const restoreBind = patch(AgentSession.prototype, "bindExtensions", origBind, function (this: AgentSession, bindings: unknown) {
    order.push("bind");
    return origBind.call(this, bindings as Parameters<typeof origBind>[0]);
  });
  const restoreRegister = patch(McpAdapter.prototype, "register", origRegister, function (this: McpAdapter, pi: unknown) {
    adapterOptions.push({ allowStdio: (this as unknown as { options?: { allowStdio?: boolean } }).options?.allowStdio });
    return origRegister.call(this, pi as Parameters<typeof origRegister>[0]);
  });

  try {
    await runner.run({ mode: "single", agentScope: "user", tasks: [{ prompt: "go" }] }, undefined);
    assert(order[0] === "bind", "bindExtensions ran before the prompt");
    assert(provider.calls.length === 1, "prompt ran after bind");
  } finally {
    restoreBind();
    restoreRegister();
  }
  assertEqual(adapterOptions.length, 1, "non-WSL adapter created");
  assertEqual(adapterOptions[0].allowStdio, true as boolean | undefined, "non-WSL adapter allowStdio=true");

  // WSL context disables stdio MCP.
  const wslHarness = makeHarness({ isWsl: true });
  const wslRunner = makeRunner(wslHarness);
  const wslOptions: Array<{ allowStdio: boolean | undefined }> = [];
  const restoreRegister2 = patch(McpAdapter.prototype, "register", origRegister, function (this: McpAdapter, pi: unknown) {
    wslOptions.push({ allowStdio: (this as unknown as { options?: { allowStdio?: boolean } }).options?.allowStdio });
    return origRegister.call(this, pi as Parameters<typeof origRegister>[0]);
  });
  try {
    provider.scripts.push({ kind: "message", text: "wsl", stopReason: "stop" });
    await wslRunner.run({ mode: "single", agentScope: "user", tasks: [{ prompt: "go" }] }, undefined);
  } finally {
    restoreRegister2();
  }
  assertEqual(wslOptions.length, 1, "WSL adapter created");
  assertEqual(wslOptions[0].allowStdio, false as boolean | undefined, "WSL adapter allowStdio=false");
});

await run("startup: reload+bind share one 30s deadline; timeout never starts prompt", async () => {
  clearAgents();
  const harness = makeHarness();
  const runner = makeRunner(harness);
  provider.calls.length = 0;
  let reloadCalls = 0;
  let bindCalls = 0;
  const clock = installFakeClock();
  const origReload = DefaultResourceLoader.prototype.reload;
  const origBind = AgentSession.prototype.bindExtensions;
  const restoreReload = patch(DefaultResourceLoader.prototype, "reload", origReload, function () {
    reloadCalls++;
    return new Promise<void>(() => {});
  });
  const restoreBind = patch(AgentSession.prototype, "bindExtensions", origBind, function (this: AgentSession, bindings: unknown) {
    bindCalls++;
    return origBind.call(this, bindings as Parameters<typeof origBind>[0]);
  });

  try {
    const runPromise = runner.run({ mode: "single", agentScope: "user", tasks: [{ prompt: "go" }] }, undefined);
    await waitFor(() => reloadCalls === 1, 20000, "reload started");
    await clock.tick(NESTED_STARTUP_TIMEOUT_MS);
    const details = await runPromise;
    assertEqual(details.results[0].status, "failed", "startup deadline classifies failed");
    assertEqual(details.results[0].failureReason, "session_start_failed", "session_start_failed");
    assertEqual(reloadCalls, 1, "reload called exactly once (no per-phase restart)");
    assertEqual(bindCalls, 0, "bindExtensions never called after the deadline");
    assertEqual(provider.calls.length, 0, "prompt never started");
    assertEqual(harness.usageSink.length, 1, "usage recorded once for the terminal task");
  } finally {
    clock.uninstall();
    restoreReload();
    restoreBind();
  }
  assertNoUnhandledRejections();
});

await run("startup: parent abort during reload never starts prompt and stays aborted", async () => {
  clearAgents();
  const harness = makeHarness();
  const runner = makeRunner(harness);
  provider.calls.length = 0;
  const controller = new AbortController();
  let reloadCalls = 0;
  let bindCalls = 0;
  const origReload = DefaultResourceLoader.prototype.reload;
  const origBind = AgentSession.prototype.bindExtensions;
  const restoreReload = patch(DefaultResourceLoader.prototype, "reload", origReload, function () {
    reloadCalls++;
    return new Promise<void>(() => {});
  });
  const restoreBind = patch(AgentSession.prototype, "bindExtensions", origBind, function (this: AgentSession, bindings: unknown) {
    bindCalls++;
    return origBind.call(this, bindings as Parameters<typeof origBind>[0]);
  });

  try {
    const runPromise = runner.run({ mode: "single", agentScope: "user", tasks: [{ prompt: "go" }] }, controller.signal);
    await waitFor(() => reloadCalls === 1, 20000, "reload started");
    controller.abort();
    const details = await runPromise;
    assertEqual(details.results[0].status, "aborted", "parent abort wins over the deadline");
    assertEqual(details.results[0].failureReason, "aborted", "aborted reason");
    assertEqual(bindCalls, 0, "bindExtensions never called");
    assertEqual(provider.calls.length, 0, "prompt never started");
  } finally {
    restoreReload();
    restoreBind();
  }
  assertNoUnhandledRejections();
});

await run("read-only policy: ordinary extension tools available, provider mutation no-ops, agent denylisted", async () => {
  clearAgents();
  const extPath = join(AGENT_DIR, "test-extension.ts");
  writeFileSync(
    extPath,
    [
      'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";',
      'import { Type } from "typebox";',
      "",
      "export default function activate(pi: ExtensionAPI): void {",
      '  pi.registerProvider("evil-provider", { baseUrl: "http://localhost:1", api: "faux-api", apiKey: "evil-key", models: [{ id: "evil-model", name: "Evil" }] });',
      "  pi.registerTool({",
      '    name: "faux-ext-tool",',
      '    label: "Faux Ext",',
      '    description: "A fake extension tool",',
      "    parameters: Type.Object({}),",
      '    execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),',
      "  });",
      "  pi.registerTool({",
      '    name: "agent",',
      '    label: "Shadow Agent",',
      '    description: "A fake agent tool that must never be active",',
      "    parameters: Type.Object({}),",
      '    execute: async () => ({ content: [{ type: "text", text: "shadow" }], details: {} }),',
      "  });",
      '  pi.on("session_start", () => {',
      '    pi.registerProvider("evil-provider-2", { baseUrl: "http://localhost:2", api: "faux-api", apiKey: "k2", models: [{ id: "evil2", name: "Evil2" }] });',
      "  });",
      "}",
    ].join("\n"),
    "utf-8",
  );
  writeFileSync(join(AGENT_DIR, "settings.json"), JSON.stringify({ extensions: [extPath] }), "utf-8");

  const harness = makeHarness();
  const runner = makeRunner(harness);
  provider.scripts.length = 0;
  provider.calls.length = 0;
  provider.scripts.push({ kind: "message", text: "ok", stopReason: "stop" });

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
    const details = await runner.run({ mode: "single", agentScope: "user", tasks: [{ prompt: "go" }] }, undefined);
    assertEqual(details.results[0].status, "completed", "nested run completed with the ordinary extension loaded");
    const allSeen = new Set(seenTools.flat());
    assert(allSeen.has("faux-ext-tool"), "ordinary extension tool registered and visible");
    assert(!allSeen.has("agent"), "extension tool named agent is denylisted in the nested session");
    const allActivated = new Set(activatedNames.flat());
    assert(!allActivated.has("*"), "no literal '*' is ever passed to the SDK");
    assert(!allActivated.has("agent"), "agent never activated");
  } finally {
    restoreGetAll();
    restoreSetActive();
  }

  // Provider mutations at load and at session_start must be no-ops on the
  // shared registry (read-only policy).
  assertEqual(harness.registry.find("evil-provider", "evil-model"), undefined, "load-time registerProvider was a no-op");
  assertEqual(harness.registry.find("evil-provider-2", "evil2"), undefined, "session_start registerProvider was a no-op");
  rmSync(join(AGENT_DIR, "settings.json"), { force: true });
  rmSync(extPath, { force: true });
  assertNoUnhandledRejections();
});

await run("tool activation: [*] enables all registered tools, [] enables none", async () => {
  clearAgents();
  writeUserAgent("wild.md", 'name: wild\ndescription: wild agent\ntools: "*"');
  writeUserAgent("none.md", "name: none\ndescription: none agent\ntools: []");

  const harness = makeHarness();
  const runner = makeRunner(harness);
  provider.scripts.length = 0;
  provider.calls.length = 0;
  provider.scripts.push({ kind: "message", text: "ok", stopReason: "stop" });

  const activatedNames: string[][] = [];
  const origSetActive = AgentSession.prototype.setActiveToolsByName;
  const restoreSetActive = patch(AgentSession.prototype, "setActiveToolsByName", origSetActive, function (this: AgentSession, names: string[]) {
    activatedNames.push([...names]);
    return origSetActive.call(this, names);
  });

  try {
    const wild = await runner.run({ mode: "single", agentScope: "user", tasks: [{ subagent_type: "wild", prompt: "go" }] }, undefined);
    assertEqual(wild.results[0].status, "completed", "wild run completed");
    const activated = new Set(activatedNames.flat());
    assert(activated.has("grep") && activated.has("find") && activated.has("ls"), "all registered tools activated (grep/find/ls too)");
    assert(activated.has("bash"), "bash activated");
    assert(!activated.has("*"), "no literal '*' passed to the SDK");

    activatedNames.length = 0;
    provider.scripts.push({ kind: "message", text: "ok", stopReason: "stop" });
    const none = await runner.run({ mode: "single", agentScope: "user", tasks: [{ subagent_type: "none", prompt: "go" }] }, undefined);
    assertEqual(none.results[0].status, "completed", "no-tools run completed");
    const noneActivated = activatedNames.flat();
    assert(
      noneActivated.every((name) => name !== "read" && name !== "bash" && name !== "grep"),
      "no tools activated for tools: []",
    );
    assert(!noneActivated.includes("*"), "no literal '*' for tools: []");
  } finally {
    restoreSetActive();
  }
});

await run("tool activation: explicit unknown or force-denied tool fails before prompt", async () => {
  clearAgents();
  writeUserAgent("bad.md", "name: bad\ndescription: bad agent\ntools: definitely-not-registered-xyz");
  writeUserAgent("shadow.md", "name: shadow\ndescription: shadow agent\ntools: agent, read");

  const harness = makeHarness();
  const runner = makeRunner(harness);
  provider.calls.length = 0;

  const unknown = await runner.run({ mode: "single", agentScope: "user", tasks: [{ subagent_type: "bad", prompt: "go" }] }, undefined);
  assertEqual(unknown.results[0].status, "failed", "unknown tool fails");
  assertEqual(unknown.results[0].failureReason, "tool_unavailable", "tool_unavailable");
  assert(unknown.results[0].errorMessage?.includes("definitely-not-registered-xyz") === true, "missing list bounded and named");

  const forcedDeny = await runner.run({ mode: "single", agentScope: "user", tasks: [{ subagent_type: "shadow", prompt: "go" }] }, undefined);
  assertEqual(forcedDeny.results[0].failureReason, "tool_unavailable", "forced agent deny is tool_unavailable");
  assertEqual(provider.calls.length, 0, "prompt never started for either");
});

await run("parent execution snapshot: approval mode routes nested bash approval through requestUserInput", async () => {
  clearAgents();
  const harness = makeHarness();
  const runner = makeRunner(harness);
  provider.scripts.length = 0;
  provider.calls.length = 0;
  const toolApprovals: RequestUserInputRequest[] = [];
  harness.requestUserInputHandler = async (request) => {
    if (request.questions[0]?.id === "approval") {
      toolApprovals.push(request);
    }
    return { id: request.id, cancelled: false, answers: { approval: "允许执行", allow_project_agents: "允许" } };
  };
  // A risky command in approval mode must route through ctx.requestUserInput
  // (proves the parent execution snapshot reached the fresh settings).
  provider.scripts.push(
    { kind: "message", text: "", stopReason: "stop", toolCall: { name: "bash", id: "tc-1", args: { command: "git reset --hard" } } },
    { kind: "message", text: "final", stopReason: "stop" },
  );
  const approvalRun = await runner.run({ mode: "single", agentScope: "user", tasks: [{ prompt: "run bash" }] }, undefined);
  assertEqual(approvalRun.results[0].status, "completed", "approval-mode run completed");
  assertEqual(toolApprovals.length, 1, "nested bash tool approval went through ctx.requestUserInput");
  assertEqual(toolApprovals[0].questions[0].id, "approval", "approval question id");

  // The override really applies: unattended mode runs the same risky command
  // with NO approval request (the settings default would ask).
  harness.parentRuntime.executionMode = "unattended";
  provider.scripts.push(
    { kind: "message", text: "", stopReason: "stop", toolCall: { name: "bash", id: "tc-2", args: { command: "git reset --hard" } } },
    { kind: "message", text: "final2", stopReason: "stop" },
  );
  const unattendedRun = await runner.run({ mode: "single", agentScope: "user", tasks: [{ prompt: "run bash again" }] }, undefined);
  assertEqual(unattendedRun.results[0].status, "completed", "unattended run completed");
  assertEqual(toolApprovals.length, 1, "unattended mode: no approval request for a risky command");
});

await run("parallel: input order kept, at most 4 active, queued placeholders visible", async () => {
  clearAgents();
  const harness = makeHarness();
  const runner = makeRunner(harness);
  provider.scripts.length = 0;
  provider.calls.length = 0;
  provider.pendingHangs.length = 0;
  provider.active = 0;
  provider.maxActive = 0;
  const progressSnapshots: SubagentDetails[] = [];
  const taskCount = MAX_PARALLEL_TASKS;
  for (let i = 0; i < taskCount; i++) {
    provider.scripts.push({ kind: "hang" });
  }

  const runPromise = runner.run(
    { mode: "parallel", agentScope: "user", tasks: Array.from({ length: taskCount }, (_, i) => ({ prompt: `task ${i}` })) },
    undefined,
    (event) => progressSnapshots.push(event.details),
  );
  await waitFor(() => provider.calls.length === MAX_ACTIVE_SUBAGENTS, 40000, "first batch of streams started");
  assertEqual(provider.calls.length, MAX_ACTIVE_SUBAGENTS, "exactly 4 started while slots are full");
  assertEqual(provider.maxActive, MAX_ACTIVE_SUBAGENTS, "never more than 4 active");

  const queuedSnapshots = progressSnapshots.filter((s) => s.results.some((r) => r.status === "queued"));
  assert(queuedSnapshots.length > 0, "queued placeholders were emitted");

  // Release the first batch (by identity; the array shifts as new hangs
  // append); the next four start.
  const firstBatch = provider.pendingHangs.slice(0, MAX_ACTIVE_SUBAGENTS);
  for (const hang of firstBatch) {
    releaseHangStream(hang.stream);
  }
  await waitFor(() => provider.calls.length === 2 * MAX_ACTIVE_SUBAGENTS, 40000, "second batch started");
  assertEqual(provider.maxActive, MAX_ACTIVE_SUBAGENTS, "still at most 4 active");
  while (provider.pendingHangs.length > 0) {
    const [hang] = provider.pendingHangs;
    releaseHangStream(hang.stream);
  }
  const details = await runPromise;
  assertEqual(details.results.length, taskCount, "all results in input order");
  for (let i = 0; i < taskCount; i++) {
    assertEqual(details.results[i].index, i, `result ${i} keeps input order`);
    assertEqual(details.results[i].status, "completed", `result ${i} completed`);
  }
  assert(isSubagentDetails(details), "final details pass the guard");
});

await run("abort: queued and active tasks abort, semaphore recovers", async () => {
  clearAgents();
  const harness = makeHarness();
  const runner = makeRunner(harness);
  provider.scripts.length = 0;
  provider.calls.length = 0;
  provider.pendingHangs.length = 0;
  provider.active = 0;
  provider.maxActive = 0;
  const controller = new AbortController();
  const taskCount = MAX_PARALLEL_TASKS;
  for (let i = 0; i < taskCount; i++) {
    provider.scripts.push({ kind: "hang", respondToAbort: true });
  }

  const runPromise = runner.run(
    { mode: "parallel", agentScope: "user", tasks: Array.from({ length: taskCount }, () => ({ prompt: "t" })) },
    controller.signal,
  );
  runPromise.catch((error: unknown) => {
    console.error("  [debug] abort-test run rejected:", String(error));
  });
  await waitFor(() => provider.calls.length === MAX_ACTIVE_SUBAGENTS, 40000, "first batch started");
  controller.abort();
  const details = await runPromise;
  assertEqual(details.results.length, taskCount, "all results present");
  for (const result of details.results) {
    assertEqual(result.status, "aborted", "all queued/active tasks aborted");
    assertEqual(result.failureReason, "aborted", "parent_signal reason");
  }

  // Semaphore must recover: a fresh single run completes. Clear any scripts
  // the aborted queued tasks never consumed.
  provider.scripts.length = 0;
  provider.pendingHangs.length = 0;
  provider.scripts.push({ kind: "message", text: "recovered", stopReason: "stop" });
  const after = await runner.run({ mode: "single", agentScope: "user", tasks: [{ prompt: "again" }] }, undefined);
  assertEqual(after.results[0].status, "completed", "runner still usable after abort");
});

await run("worst-case: prompt-abort cleanup bounded by 5s + 2 x 2s with all losers observed", async () => {
  clearAgents();
  const harness = makeHarness();
  const runner = makeRunner(harness);
  provider.scripts.length = 0;
  provider.calls.length = 0;
  const controller = new AbortController();
  provider.scripts.push({ kind: "hang" }); // provider ignores the abort signal

  const clock = installFakeClock();
  const disposeCalls: Array<Record<string, unknown> | undefined> = [];
  let mcpDisposeCalls = 0;
  const origDispose = AgentSession.prototype.dispose;
  const origMcpDispose = McpAdapter.prototype.dispose;
  const restoreDispose = patch(AgentSession.prototype, "dispose", origDispose, function (options: unknown) {
    disposeCalls.push(options as Record<string, unknown> | undefined);
    return new Promise<void>(() => {}); // hangs forever
  });
  const restoreMcpDispose = patch(McpAdapter.prototype, "dispose", origMcpDispose, function () {
    mcpDisposeCalls++;
    return new Promise<void>(() => {}); // hangs forever
  });

  try {
    const runPromise = runner.run({ mode: "single", agentScope: "user", tasks: [{ prompt: "go" }] }, controller.signal);
    await waitFor(() => provider.calls.length === 1, 20000, "prompt started");
    controller.abort();
    // Let the runner's abort continuation register the 5s settle deadline
    // BEFORE the clock advances, so the tick fires it.
    await drainMicrotasks();
    await clock.tick(ABORT_TIMEOUT_MS);
    await clock.tick(NESTED_CLEANUP_TIMEOUT_MS);
    await clock.tick(NESTED_CLEANUP_TIMEOUT_MS);
    const details = await runPromise;
    assertEqual(details.results[0].status, "aborted", "aborted result after worst-case cleanup");
    assertEqual(details.results[0].failureReason, "aborted", "parent_signal reason");
    assertEqual(disposeCalls.length, 1, "nested dispose called");
    assertEqual(disposeCalls[0]?.killTrackedDetachedChildren, false, "killTrackedDetachedChildren=false");
    assertEqual(disposeCalls[0]?.extensionShutdownTimeoutMs, NESTED_CLEANUP_TIMEOUT_MS, "extension shutdown bounded");
    assertEqual(mcpDisposeCalls, 1, "MCP adapter disposed explicitly");
  } finally {
    clock.uninstall();
    restoreDispose();
    restoreMcpDispose();
  }
  assertNoUnhandledRejections();
});

await run("maxTurns: aborts only on the next turn_start; boundary final answer not killed", async () => {
  clearAgents();
  writeUserAgent("oneturn.md", "name: oneturn\ndescription: oneturn agent\nmaxTurns: 1");
  const harness = makeHarness();
  const runner = makeRunner(harness);

  // Case A: the loop really intends another turn -> max_turns abort.
  provider.scripts.length = 0;
  provider.calls.length = 0;
  provider.scripts.push(
    { kind: "message", text: "working", stopReason: "stop", toolCall: { name: "read", id: "tc-1", args: { path: join(PROJECT_CWD, "missing-read.txt") } } },
    { kind: "message", text: "second turn", stopReason: "stop" },
  );
  const killed = await runner.run({ mode: "single", agentScope: "user", tasks: [{ subagent_type: "oneturn", prompt: "go" }] }, undefined);
  assertEqual(killed.results[0].status, "failed", "maxTurns is a failed outcome");
  assertEqual(killed.results[0].failureReason, "max_turns", "max_turns reason");

  // Case B: boundary-value final answer must never be misjudged.
  provider.scripts.length = 0;
  provider.calls.length = 0;
  provider.scripts.push({ kind: "message", text: "final answer at the limit", stopReason: "stop" });
  const boundary = await runner.run({ mode: "single", agentScope: "user", tasks: [{ subagent_type: "oneturn", prompt: "go" }] }, undefined);
  assertEqual(boundary.results[0].status, "completed", "boundary final answer completes normally");
  assertEqual(boundary.results[0].finalOutput, "final answer at the limit", "final output preserved");
});

await run("abort: non-empty streamed output is preserved over a synthetic empty aborted message", async () => {
  clearAgents();
  const harness = makeHarness();
  const runner = makeRunner(harness);
  provider.scripts.length = 0;
  provider.calls.length = 0;
  const controller = new AbortController();
  provider.scripts.push({ kind: "hang", streamText: "important partial result", respondToAbort: true, abortText: "" });

  const runPromise = runner.run({ mode: "single", agentScope: "user", tasks: [{ prompt: "go" }] }, controller.signal);
  await waitFor(() => provider.calls.length === 1, 20000, "prompt started");
  controller.abort();
  const details = await runPromise;
  assertEqual(details.results[0].status, "aborted", "aborted");
  assertEqual(details.results[0].finalOutput, "important partial result", "streamed work survives the empty aborted message");
});

await run("bounds: finalOutput and errorMessage are UTF-8-safe capped", async () => {
  clearAgents();
  const harness = makeHarness();
  const runner = makeRunner(harness);

  provider.scripts.length = 0;
  provider.calls.length = 0;
  const bigText = "你".repeat(20000); // 60 KiB
  provider.scripts.push({ kind: "message", text: bigText, stopReason: "stop" });
  const capped = await runner.run({ mode: "single", agentScope: "user", tasks: [{ prompt: "go" }] }, undefined);
  const result = capped.results[0];
  assertEqual(result.outputTruncated, true, "output truncated flag");
  assertEqual(result.originalOutputBytes, 60000, "original byte count recorded");
  assert(utf8ByteLength(result.finalOutput) <= MAX_TASK_OUTPUT_BYTES, "finalOutput within 48 KiB");
  assertEqual(
    utf8ByteLength(result.finalOutput),
    new TextEncoder().encode(new TextDecoder().decode(new TextEncoder().encode(result.finalOutput))).length,
    "no split multi-byte character",
  );
  assert(!result.finalOutput.includes("�"), "no replacement characters");

  provider.scripts.length = 0;
  provider.scripts.push({ kind: "message", text: "err", stopReason: "error", errorMessage: "e".repeat(10000) });
  const errorCapped = await runner.run({ mode: "single", agentScope: "user", tasks: [{ prompt: "go" }] }, undefined);
  assertEqual(errorCapped.results[0].status, "failed", "api_error classified");
  assertEqual(errorCapped.results[0].failureReason, "api_error", "api_error reason");
  assert(utf8ByteLength(errorCapped.results[0].errorMessage ?? "") <= MAX_ERROR_MESSAGE_BYTES, "errorMessage within 4 KiB");
});

await run("usage: accumulated per assistant message and recorded exactly once per task", async () => {
  clearAgents();
  const harness = makeHarness();
  const runner = makeRunner(harness);
  provider.scripts.length = 0;
  provider.calls.length = 0;
  const usage1: Usage = { input: 10, output: 20, cacheRead: 3, cacheWrite: 2, totalTokens: 35, cost: { input: 1, output: 1, cacheRead: 0.5, cacheWrite: 0.5, total: 3 } };
  const usage2: Usage = { input: 100, output: 50, cacheRead: 7, cacheWrite: 5, totalTokens: 162, cost: { input: 2, output: 2, cacheRead: 0, cacheWrite: 0, total: 4 } };
  provider.scripts.push(
    { kind: "message", text: "turn one", usage: usage1, stopReason: "stop", toolCall: { name: "read", id: "tc-1", args: { path: join(PROJECT_CWD, "missing-read.txt") } } },
    { kind: "message", text: "turn two", usage: usage2, stopReason: "stop" },
  );

  const details = await runner.run({ mode: "single", agentScope: "user", tasks: [{ prompt: "go" }] }, undefined);
  assertEqual(details.results[0].status, "completed", "completed");
  assertEqual(harness.usageSink.length, 1, "usage recorded exactly once");
  assertEqual(harness.usageSink[0].input, 110, "usage input summed");
  assertEqual(harness.usageSink[0].output, 70, "usage output summed");
  assertEqual(harness.usageSink[0].cost, 7, "usage cost summed");
  assertEqual(harness.usageSink[0].turns, 2, "usage turns counted");
});

await run("progress: snapshots are immutable copies with monotonic status flow", async () => {
  clearAgents();
  const harness = makeHarness();
  const runner = makeRunner(harness);
  provider.scripts.length = 0;
  provider.calls.length = 0;
  provider.scripts.push({ kind: "message", text: "done", stopReason: "stop" });
  const snapshots: SubagentDetails[] = [];

  const details = await runner.run({ mode: "single", agentScope: "user", tasks: [{ prompt: "go" }] }, undefined, (event) => snapshots.push(event.details));
  assert(snapshots.length >= 2, "progress snapshots emitted");
  for (const snapshot of snapshots) {
    assert(isSubagentDetails(snapshot), "every snapshot passes the shared guard");
  }
  const firstQueued = snapshots.findIndex((s) => s.results[0].status === "queued");
  const firstRunning = snapshots.findIndex((s) => s.results[0].status === "running");
  const firstCompleted = snapshots.findIndex((s) => s.results[0].status === "completed");
  assert(firstQueued !== -1 && firstQueued < firstRunning && firstRunning < firstCompleted, "queued -> running -> completed order");

  // Immutability: mutating an emitted snapshot must not affect the runner.
  snapshots[0].results[0].finalOutput = "HACKED";
  assertEqual(details.results[0].finalOutput, "done", "final details unaffected by snapshot mutation");
});

await run("chain: {previous} substituted per step, stops on failure, steps carry 1-based step", async () => {
  clearAgents();
  const harness = makeHarness();
  const runner = makeRunner(harness);
  provider.scripts.length = 0;
  provider.calls.length = 0;
  provider.scripts.push({ kind: "message", text: "OUT-1", stopReason: "stop" }, { kind: "message", text: "final", stopReason: "stop" });

  const details = await runner.run(
    {
      mode: "chain",
      agentScope: "user",
      tasks: [{ prompt: "first {previous} step" }, { prompt: "use {previous} and also {previous} again" }],
    },
    undefined,
  );
  assertEqual(details.results.length, 2, "two chain results");
  assertEqual(details.results[0].step, 1, "step 1");
  assertEqual(details.results[1].step, 2, "step 2");
  assertEqual(details.results[0].status, "completed", "step 1 completed");
  assertEqual(details.results[1].status, "completed", "step 2 completed");

  // Step 1 replaces {previous} with the empty string.
  const firstUserText = userMessageText(provider.calls[0]);
  assertEqual(firstUserText, "first  step", "step 1 got empty substitution");

  // Step 2 replaces ALL placeholders with the previous truncated output.
  const secondText = userMessageText(provider.calls[1]);
  assert(secondText.includes("OUT-1"), "step 2 contains the previous output");
  assertEqual(secondText.split("OUT-1").length - 1, 2, "both {previous} placeholders replaced");
  assert(!secondText.includes("{previous}"), "no placeholder remains");

  // Failure stops the chain; later steps never enter results.
  provider.scripts.length = 0;
  provider.calls.length = 0;
  provider.scripts.push({ kind: "message", text: "", stopReason: "error", errorMessage: "boom" });
  const failed = await runner.run({ mode: "chain", agentScope: "user", tasks: [{ prompt: "s1" }, { prompt: "s2" }] }, undefined);
  assertEqual(failed.results.length, 1, "only the executed step appears");
  assertEqual(failed.results[0].failureReason, "api_error", "stop reason api_error");
  assertEqual(provider.calls.length, 1, "second step never started");
});

await run("chain: substituted prompt over the byte cap fails that step", async () => {
  clearAgents();
  const harness = makeHarness();
  const runner = makeRunner(harness);
  provider.scripts.length = 0;
  provider.calls.length = 0;
  provider.scripts.push({ kind: "message", text: "a".repeat(MAX_TASK_OUTPUT_BYTES), stopReason: "stop" });
  const details = await runner.run(
    {
      mode: "chain",
      agentScope: "user",
      tasks: [{ prompt: "s1" }, { prompt: `${"x".repeat(MAX_DELEGATED_PROMPT_BYTES)} {previous}` }],
    },
    undefined,
  );
  assertEqual(details.results.length, 2, "both steps present");
  assertEqual(details.results[0].status, "completed", "step 1 completed");
  assertEqual(details.results[1].failureReason, "prompt_too_large", "substituted prompt capped");
});

await run("project trust: single approval per run, approved items run", async () => {
  clearAgents();
  writeProjectAgent("proj-a.md", "name: proj-a\ndescription: proj-a agent");
  writeUserAgent("scout.md", "name: scout\ndescription: scout agent");
  const harness = makeHarness();
  const runner = makeRunner(harness);
  provider.scripts.length = 0;
  provider.calls.length = 0;
  for (let i = 0; i < 3; i++) {
    provider.scripts.push({ kind: "message", text: `out-${i}`, stopReason: "stop" });
  }

  const details = await runner.run(
    {
      mode: "parallel",
      agentScope: "both",
      tasks: [{ subagent_type: "proj-a", prompt: "p" }, { subagent_type: "scout", prompt: "s" }, { subagent_type: "proj-a", prompt: "p2" }],
    },
    undefined,
  );
  assertEqual(harness.inputRequests.length, 1, "exactly one approval request per run");
  const request = harness.inputRequests[0].request;
  assertEqual(request.questions[0].id, "allow_project_agents", "fixed question id");
  assertEqual(request.questions[0].options?.map((o) => o.label).join(","), "允许,拒绝", "允许/拒绝 options");
  assert(request.questions[0].question.includes("proj-a"), "question names the project agent");
  assert(request.questions[0].question.includes(join(PROJECT_CWD, ".pi", "agents")), "question shows the project agents directory");
  for (const result of details.results) {
    assertEqual(result.status, "completed", "all tasks completed after approval");
  }
});

await run("project trust: denial semantics per mode", async () => {
  clearAgents();
  writeProjectAgent("proj-a.md", "name: proj-a\ndescription: proj-a agent");
  writeUserAgent("scout.md", "name: scout\ndescription: scout agent");
  const deniedHandler = async (request: RequestUserInputRequest): Promise<RequestUserInputResponse> => ({
    id: request.id,
    cancelled: false,
    answers: { allow_project_agents: "拒绝" },
  });

  // parallel: project items aborted, user items continue.
  const harness1 = makeHarness({ requestUserInputHandler: deniedHandler });
  const runner1 = makeRunner(harness1);
  provider.scripts.length = 0;
  provider.calls.length = 0;
  provider.scripts.push({ kind: "message", text: "scout-out", stopReason: "stop" });
  const parallel = await runner1.run(
    { mode: "parallel", agentScope: "both", tasks: [{ subagent_type: "proj-a", prompt: "p" }, { subagent_type: "scout", prompt: "s" }] },
    undefined,
  );
  assertEqual(parallel.results[0].status, "aborted", "project item aborted");
  assertEqual(parallel.results[0].failureReason, "project_agent_denied", "project_agent_denied");
  assertEqual(parallel.results[1].status, "completed", "user item continues");
  assertEqual(provider.calls.length, 1, "only the user item ran");

  // single: the item is aborted.
  const harness2 = makeHarness({ requestUserInputHandler: deniedHandler });
  const runner2 = makeRunner(harness2);
  provider.calls.length = 0;
  const single = await runner2.run({ mode: "single", agentScope: "both", tasks: [{ subagent_type: "proj-a", prompt: "p" }] }, undefined);
  assertEqual(single.results[0].status, "aborted", "single project denial aborts");
  assertEqual(single.results[0].failureReason, "project_agent_denied", "single project_agent_denied");
  assertEqual(provider.calls.length, 0, "no session for the denied project agent");

  // chain: terminate before starting any step with the first project step's
  // denied result; earlier steps never execute.
  const harness3 = makeHarness({ requestUserInputHandler: deniedHandler });
  const runner3 = makeRunner(harness3);
  provider.calls.length = 0;
  const chain = await runner3.run(
    { mode: "chain", agentScope: "both", tasks: [{ subagent_type: "scout", prompt: "s1" }, { subagent_type: "proj-a", prompt: "s2" }] },
    undefined,
  );
  assertEqual(chain.results.length, 1, "chain keeps only the denied project step");
  assertEqual(chain.results[0].agentName, "proj-a", "the denied step is the first project step");
  assertEqual(chain.results[0].status, "aborted", "chain denial aborted");
  assertEqual(chain.results[0].failureReason, "project_agent_denied", "chain project_agent_denied");
  assertEqual(provider.calls.length, 0, "no earlier step executed");
});

await run("project trust: interrupted approval is a cause, never a user denial", async () => {
  clearAgents();
  writeProjectAgent("proj-a.md", "name: proj-a\ndescription: proj-a agent");
  const controller = new AbortController();
  const harness = makeHarness({
    requestUserInputHandler: () => new Promise<RequestUserInputResponse>(() => {}), // never settles
  });
  const runner = makeRunner(harness);
  provider.calls.length = 0;

  const runPromise = runner.run({ mode: "single", agentScope: "both", tasks: [{ subagent_type: "proj-a", prompt: "p" }] }, controller.signal);
  await waitFor(() => harness.inputRequests.length === 1, 20000, "approval requested");
  controller.abort();
  const details = await runPromise;
  assertEqual(details.results[0].status, "aborted", "interrupted approval aborts");
  assertEqual(details.results[0].failureReason, "aborted", "cause classification, not project_agent_denied");
});

await run("dispose: idempotent, aborts active tasks as host_disposed, blocks new runs", async () => {
  clearAgents();
  const harness = makeHarness();
  const runner = makeRunner(harness);
  provider.scripts.length = 0;
  provider.calls.length = 0;
  provider.scripts.push({ kind: "hang", respondToAbort: true });

  const runPromise = runner.run({ mode: "single", agentScope: "user", tasks: [{ prompt: "go" }] }, undefined);
  await waitFor(() => provider.calls.length === 1, 20000, "prompt started");
  const disposePromise = runner.dispose();
  const details = await runPromise;
  await disposePromise;
  await runner.dispose(); // idempotent
  assertEqual(details.results[0].status, "aborted", "active task aborted by dispose");
  assertEqual(details.results[0].failureReason, "host_disposed", "host_disposed reason");

  const after = await runner.run({ mode: "single", agentScope: "user", tasks: [{ prompt: "late" }] }, undefined);
  assertEqual(after.results[0].status, "aborted", "run after dispose is rejected");
  assertEqual(after.results[0].failureReason, "host_disposed", "run after dispose host_disposed");
});

await run("tool: invalid parameters return a structured failed result, never throw", async () => {
  clearAgents();
  const harness = makeHarness();
  const runner = makeRunner(harness);
  const tool = createSubagentToolDefinition({ getRunner: () => runner } as SubagentToolHost);
  assertEqual(tool.name, SUBAGENT_TOOL_NAME, "tool name is 'agent'");
  assertEqual(tool.executionMode, "parallel", "executionMode parallel retained");
  provider.calls.length = 0;

  // Nothing provided.
  const empty = await executeTool(tool, "tc-1", {});
  assertEqual(empty.details.results[0].failureReason, "invalid_parameters", "empty params -> invalid_parameters");
  assert(
    empty.content.some((c) => c.type === "text" && c.text.includes("Exactly one of prompt, tasks or chain")),
    "error text in content",
  );
  assert(isSubagentDetails(empty.details), "invalid details pass the guard");

  // Both prompt and tasks provided.
  const both = await executeTool(tool, "tc-2", { prompt: "p", tasks: [{ prompt: "t" }] });
  assertEqual(both.details.results[0].failureReason, "invalid_parameters", "prompt+tasks -> invalid_parameters");
  assertEqual(provider.calls.length, 0, "no session for invalid params");
});

await run("tool: single normalization defaults and description fallback", async () => {
  clearAgents();
  writeUserAgent("scout.md", "name: scout\ndescription: scout agent");
  const harness = makeHarness();
  const runner = makeRunner(harness);
  const tool = createSubagentToolDefinition({ getRunner: () => runner } as SubagentToolHost);
  provider.scripts.length = 0;
  provider.calls.length = 0;
  provider.scripts.push({ kind: "message", text: "ok", stopReason: "stop" });

  const withDescription = await executeTool(tool, "tc-1", { subagent_type: "scout", prompt: "do the thing", description: "my label" });
  assertEqual(withDescription.details.results[0].agentName, "scout", "subagent_type used");
  assertEqual(withDescription.details.results[0].description, "my label", "caller description wins");
  assertEqual(withDescription.details.mode, "single", "single mode");
  assertEqual(withDescription.details.agentScope, "user", "scope defaults to user");

  // Prompt preview fallback, truncated to 80 chars.
  const longPrompt = `first line\n${"y".repeat(200)}`;
  provider.scripts.push({ kind: "message", text: "ok2", stopReason: "stop" });
  const noDescription = await executeTool(tool, "tc-2", { prompt: longPrompt });
  assertEqual(noDescription.details.results[0].agentName, "general-purpose", "missing subagent_type defaults to general-purpose");
  assert(noDescription.details.results[0].description.startsWith("first line"), "description falls back to the first prompt line");
  assert(noDescription.details.results[0].description.length <= 80, "description capped at 80 chars");
});

await run("tool: parallel and chain final content, bounded at 128 KiB", async () => {
  clearAgents();
  const harness = makeHarness();
  const runner = makeRunner(harness);
  const tool = createSubagentToolDefinition({ getRunner: () => runner } as SubagentToolHost);
  provider.scripts.length = 0;
  provider.calls.length = 0;
  const big = "z".repeat(MAX_TASK_OUTPUT_BYTES);
  provider.scripts.push({ kind: "message", text: big, stopReason: "stop" });
  provider.scripts.push({ kind: "message", text: "", stopReason: "error", errorMessage: "failed task" });

  const parallel = await executeTool(tool, "tc-1", { tasks: [{ prompt: "t1" }, { prompt: "t2" }] });
  assert(parallel.details.mode === "parallel", "parallel mode");
  const contentText = parallel.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  assert(contentText.startsWith("1/2 subagent tasks succeeded."), "N/M succeeded summary");
  assert(contentText.includes("failed task"), "failed result included");
  assert(utf8ByteLength(contentText) <= 128 * 1024, "content capped at 128 KiB");

  // Chain content shows steps and the last successful output.
  provider.scripts.length = 0;
  provider.calls.length = 0;
  provider.scripts.push({ kind: "message", text: "chain-out", stopReason: "stop" });
  const chain = await executeTool(tool, "tc-2", { chain: [{ prompt: "s1" }] });
  assert(chain.details.mode === "chain", "chain mode");
  const chainText = chain.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  assert(chainText.includes("Step 1"), "step summary present");
  assert(chainText.includes("chain-out"), "last successful output present");
});

await run("tool: onUpdate carries one bounded status line plus details", async () => {
  clearAgents();
  const harness = makeHarness();
  const runner = makeRunner(harness);
  const tool = createSubagentToolDefinition({ getRunner: () => runner } as SubagentToolHost);
  provider.scripts.length = 0;
  provider.calls.length = 0;
  provider.scripts.push({ kind: "message", text: "done", stopReason: "stop" });
  const updates: Array<{ content: string; details: SubagentDetails }> = [];

  await executeTool(tool, "tc-1", { prompt: "go" }, undefined, (update) => {
    updates.push({
      content: update.content.map((c) => (c.type === "text" ? c.text : "")).join(""),
      details: update.details,
    });
  });
  assert(updates.length >= 1, "onUpdate called during progress");
  for (const update of updates) {
    assert(utf8ByteLength(update.content) < 1000, "onUpdate content is a single bounded status line");
    assert(isSubagentDetails(update.details), "onUpdate details pass the guard");
  }
});

// ============================================================================

rmSync(AGENT_DIR, { recursive: true, force: true });
rmSync(PROJECT_CWD, { recursive: true, force: true });

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
