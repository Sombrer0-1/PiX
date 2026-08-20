/**
 * Plan deviation detection + foreground-subagent file_change forwarding tests
 * (PiX 1.4.0, P1).
 *
 * Covers canonicalizeLogicalPath (lexical + canonical containment, case
 * folding, nearest-existing-ancestor canonicalization, symlink/junction
 * escape), detectFileDeviation (declared dir/exact-file scope, out-of-scope,
 * workspace escape, empty path), detectCommandDeviation (fixed match rule),
 * validatePlanDraft (DAG, path semantics, 1.4.0 version gate), the 1.4.1
 * SubagentRunner service-facade file_change forwarding (stubbed app service),
 * and the SessionBridge foreground plan adapter end-to-end (a stubbed
 * task_file_change for a nested write outside the declared scope returns the
 * deviation with StepDelegateResult).
 *
 * Run with: npm exec tsx -- src/main/__tests__/plan-deviation-foreground-subagent.test.ts
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  Usage,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  AuthStorage,
  ModelRegistry,
  loadAgents,
  type AgentExecutionMode,
  type RequestUserInputRequest,
  type RequestUserInputResponse,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { PlanDeviation, PlanStep, PlanStepFile } from "../../shared/plan-types.js";
import type { ProjectLocation, ThinkingLevel } from "../../shared/types.js";
import {
  canonicalizeLogicalPath,
  detectCommandDeviation,
  detectFileDeviation,
  validatePlanDraft,
  type PlanPathContext,
  type SubmitUserPlanParams,
} from "../plan/plan-deviation.js";
import type { PlanStepExecutionLink, StepDelegateResult } from "../plan/plan-controller.js";
import { SubagentRunner } from "../subagent/subagent-runner.js";
import type { SubagentExecutionContext } from "../subagent/types.js";
import type { SubagentDetails, SubagentUsage } from "../../shared/subagent-types.js";
import type { AgentTaskGroupHandle } from "../../shared/agent-task-types.js";
import type { FileChangeSummary, TurnDiffSummary } from "@earendil-works/pi-coding-agent";
import type { AgentTaskService } from "../agent-task/agent-task-service.js";
import { SessionBridge } from "../session-bridge.js";

// ============================================================================
// Test harness
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
// Shared temp environment (runner harness mirrors subagent-runner.test.ts)
// ============================================================================

const AGENT_DIR = mkdtempSync(join(tmpdir(), "pix-plan-dev-agent-"));
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
const AGENTS_DIR = join(AGENT_DIR, "agents");
mkdirSync(AGENTS_DIR, { recursive: true });
const PROJECT_CWD = mkdtempSync(join(tmpdir(), "pix-plan-dev-project-"));
mkdirSync(join(PROJECT_CWD, "src"), { recursive: true });
writeFileSync(join(PROJECT_CWD, "src", "a.txt"), "hello", "utf-8");

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
      ],
    },
  },
};

function writeModelsJson(): void {
  writeFileSync(join(AGENT_DIR, "models.json"), JSON.stringify(MODELS_JSON, null, 2), "utf-8");
}

writeModelsJson();

function makeLocation(): ProjectLocation {
  return {
    path: PROJECT_CWD,
    physicalPath: PROJECT_CWD,
    name: basename(PROJECT_CWD),
    environment: { kind: "windows" },
  };
}

// ============================================================================
// Faux pi-ai provider
// ============================================================================

type StreamScript =
  | {
      kind: "message";
      text?: string;
      stopReason?: "stop" | "error" | "aborted";
      toolCall?: { name: string; id: string; args: Record<string, unknown> };
    }
  | { kind: "hang" };

interface ProviderCall {
  model: Model<Api>;
  context: Context;
  options: SimpleStreamOptions | undefined;
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
    usage: zeroUsage(),
    stopReason: opts.kind === "message" ? opts.stopReason ?? "stop" : "stop",
    timestamp: Date.now(),
  };
}

const providerScripts: StreamScript[] = [];
const providerCalls: ProviderCall[] = [];

function fauxStream(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
  providerCalls.push({ model, context, options });
  const stream = createAssistantMessageEventStream();
  const script = providerScripts.shift() ?? { kind: "message", text: "", stopReason: "stop" };
  if (script.kind === "hang") {
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

// ============================================================================
// Deviation helpers
// ============================================================================

function pathContext(): PlanPathContext {
  return { logicalCwd: PROJECT_CWD, isWsl: false };
}

function makeStep(files: PlanStepFile[], expectedCommands: string[] = []): PlanStep {
  return {
    stepKey: "s0",
    stepId: "step-1",
    title: "t",
    description: "d",
    files,
    expectedCommands,
    executionTarget: "parent",
    risk: "low",
    riskReason: "r",
    effort: "small",
    verification: "v",
    dependsOn: [],
    status: "running",
    waitingReason: "",
  };
}

function makeDraft(): SubmitUserPlanParams {
  return {
    generationId: "g1",
    title: "Refactor",
    summary: "Refactor the module.",
    steps: [
      {
        stepKey: "s0",
        title: "Inspect",
        description: "Inspect the module.",
        files: [{ path: "src/a.txt", operation: "read" }],
        executionTarget: "parent",
        risk: "low",
        riskReason: "Read-only.",
        effort: "small",
        verification: "Seams documented.",
        dependsOn: [],
      },
      {
        stepKey: "s1",
        title: "Refactor",
        description: "Refactor the module.",
        files: [{ path: "src/", operation: "modify" }],
        expectedCommands: ["npm test"],
        executionTarget: "subagent_foreground",
        risk: "medium",
        riskReason: "Modifies sources.",
        effort: "medium",
        verification: "npm test passes.",
        dependsOn: ["s0"],
      },
    ],
  };
}

async function validate(draft: SubmitUserPlanParams): Promise<{ ok: boolean; errors: string[] }> {
  const result = await validatePlanDraft(draft, {
    project: makeLocation(),
    logicalCwd: PROJECT_CWD,
    release: "1.4.0",
  });
  return { ok: result.ok, errors: result.fieldErrors.map((e) => `${e.path}: ${e.message}`) };
}

// ============================================================================
// Runner harness (mirrors subagent-runner.test.ts)
// ============================================================================

interface RunnerHarness {
  ctx: SubagentExecutionContext;
  registry: ModelRegistry;
  parentRuntime: {
    model: Model<Api> | undefined;
    thinkingLevel: ThinkingLevel;
    executionMode: AgentExecutionMode;
    verificationGate: boolean;
  };
  requestUserInputHandler: (request: RequestUserInputRequest, signal?: AbortSignal) => Promise<RequestUserInputResponse>;
}

function makeRunnerHarness(serviceStub?: AgentTaskService): RunnerHarness {
  const authStorage = AuthStorage.create(join(AGENT_DIR, "auth.json"));
  const registry = ModelRegistry.create(authStorage, join(AGENT_DIR, "models.json"));
  registry.registerProvider("faux", { api: "faux-api", streamSimple: fauxStream });
  const parentModel = registry.find("faux", "faux-model");
  const harness: RunnerHarness = {
    ctx: undefined as unknown as SubagentExecutionContext,
    registry,
    parentRuntime: {
      model: parentModel,
      thinkingLevel: "high",
      executionMode: "unattended",
      verificationGate: false,
    },
    requestUserInputHandler: async (request) => ({
      id: request.id,
      cancelled: false,
      answers: { approval: "允许执行", allow_project_agents: "允许" },
    }),
  };
  harness.ctx = {
    physicalCwd: PROJECT_CWD,
    logicalCwd: PROJECT_CWD,
    agentDir: AGENT_DIR,
    executionBackend: undefined,
    runtimeEnvironmentOverride: undefined,
    authStorage,
    modelRegistry: registry,
    isWsl: false,
    getLoadedAgents: () => loadAgents({ cwd: PROJECT_CWD, agentDir: AGENT_DIR, includeBuiltIns: true }),
    getParentRuntime: () => harness.parentRuntime,
    requestUserInput: (request, signal) => harness.requestUserInputHandler(request, signal),
    recordAuxiliaryUsage: (_usage: SubagentUsage) => {
      // no-op sink
    },
    getTaskService: () => serviceStub ?? (makeServiceStub() as unknown as AgentTaskService),
    getSessionId: () => "session-stub",
    getProjectLocation: () => ({
      physicalPath: PROJECT_CWD,
      logicalCwd: PROJECT_CWD,
      environment: { kind: "windows" },
    }),
  };
  return harness;
}

/**
 * 1.4.1 service-facade stub: the SubagentRunner facade and the SessionBridge
 * plan adapter delegate to the app-level AgentTaskService. Tests stub it with
 * scripted task_file_change events (emitted when awaitGroup is called) and a
 * completed SubagentDetails, keeping the facade/adapter integration covered
 * without spawning real nested sessions (B2 covers the runtime file_change
 * forwarding against a real nested session).
 */
function makeServiceStub(): {
  scriptFileChange: (path: string, toolCallId: string, toolName: string) => void;
  createTaskGroup: (params: {
    mode: string;
    agentScope: string;
    tasks: Array<{ description?: string }>;
    runInBackground?: boolean;
    planLink?: unknown;
  }) => Promise<AgentTaskGroupHandle>;
  awaitGroup: () => Promise<{ kind: "completed"; details: SubagentDetails }>;
  onEvent: (listener: (event: unknown) => void) => () => void;
  getAll: () => { tasks: [] };
  cancelGroup: () => Promise<void>;
} {
  const listeners: Array<(event: unknown) => void> = [];
  const pendingChanges: Array<{ path: string; toolCallId: string; toolName: string }> = [];
  let groupSeq = 0;
  return {
    scriptFileChange: (path, toolCallId, toolName) => {
      pendingChanges.push({ path, toolCallId, toolName });
    },
    createTaskGroup: async (params) => {
      groupSeq += 1;
      return {
        kind: "agent_task_group",
        groupId: `stub-group-${groupSeq}`,
        mode: "single",
        tasks: [
          {
            kind: "agent_task",
            taskId: `stub-task-${groupSeq}`,
            generation: 0,
            status: "completed",
            description: params.tasks[0]?.description ?? "",
            presentation: "foreground",
          },
        ],
      };
    },
    awaitGroup: async () => {
      for (const pc of pendingChanges) {
        const change: FileChangeSummary = { path: pc.path, toolCallId: pc.toolCallId, toolName: pc.toolName, added: 1, removed: 0 };
        const aggregate: TurnDiffSummary = { added: 1, removed: 0, files: 1, changes: [change] };
        for (const cb of [...listeners]) {
          cb({ type: "task_file_change", taskId: `stub-task-${groupSeq}`, change, aggregate });
        }
      }
      pendingChanges.length = 0;
      return { kind: "completed", details: makeStubDetails() };
    },
    onEvent: (listener) => {
      listeners.push(listener);
      return () => {
        const i = listeners.indexOf(listener);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    getAll: () => ({ tasks: [] }),
    cancelGroup: async () => {},
  };
}

function makeStubDetails(): SubagentDetails {
  const usage: SubagentUsage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: 0, turns: 1 };
  return {
    schemaVersion: 1,
    mode: "single",
    agentScope: "user",
    startedAt: 0,
    updatedAt: 0,
    durationMs: 0,
    results: [
      {
        id: "stub-result",
        index: 0,
        agentName: "general-purpose",
        agentSource: "built-in",
        description: "stub",
        status: "completed",
        finalOutput: "stub output",
        outputTruncated: false,
        originalOutputBytes: 10,
        toolUseCount: 0,
        activities: [],
        usage,
        durationMs: 0,
      },
    ],
  };
}

// ============================================================================
// Tests
// ============================================================================

await run("canonicalizeLogicalPath: containment, case folding, ancestor walk", async () => {
  const ctx = pathContext();
  const inside = await canonicalizeLogicalPath(join(PROJECT_CWD, "src", "a.txt"), ctx);
  assertEqual(inside.insideWorkspace, true, "existing file inside workspace");
  assertEqual(inside.canonicalized, true, "existing file fully canonicalized");
  assertEqual(inside.absolutePath, join(PROJECT_CWD, "src", "a.txt"), "absolute path normalized");

  const outside = await canonicalizeLogicalPath(join(tmpdir(), "unrelated-dir", "x.txt"), ctx);
  assertEqual(outside.insideWorkspace, false, "path outside workspace rejected");

  const nonexistent = await canonicalizeLogicalPath(join(PROJECT_CWD, "src", "deep", "new", "file.ts"), ctx);
  assertEqual(nonexistent.insideWorkspace, true, "nonexistent path inside workspace");
  assertEqual(nonexistent.canonicalized, false, "nonexistent path canonicalized to nearest existing ancestor");
  assertEqual(
    nonexistent.comparisonKey,
    join(PROJECT_CWD, "src", "deep", "new", "file.ts").toLowerCase(),
    "ancestor canonical key + remaining segments",
  );

  // Windows case folding: the keys agree regardless of declared casing.
  const upper = await canonicalizeLogicalPath(join(PROJECT_CWD, "SRC", "A.TXT"), ctx);
  assertEqual(upper.comparisonKey, inside.comparisonKey, "case-folded comparison key");
});

await run("canonicalizeLogicalPath: symlink/junction ancestor escape rejected", async () => {
  const outsideDir = mkdtempSync(join(tmpdir(), "pix-plan-outside-"));
  const junction = join(PROJECT_CWD, "escape-link");
  let created = true;
  try {
    symlinkSync(outsideDir, junction, "junction");
  } catch {
    created = false;
    console.log("  (junction creation not permitted; skipping symlink assertions)");
  }
  if (created) {
    try {
      const escaped = await canonicalizeLogicalPath(join(junction, "secret.txt"), pathContext());
      assertEqual(escaped.insideWorkspace, false, "path through a junction escaping the workspace rejected");
    } finally {
      rmSync(junction, { recursive: true, force: true });
    }
  }
  rmSync(outsideDir, { recursive: true, force: true });
});

await run("detectFileDeviation: declared dir/exact scope, escape, empty path", async () => {
  const ctx = pathContext();
  const dirStep = makeStep([{ path: "src/", operation: "modify" }]);
  const inside = await detectFileDeviation(
    { path: "src/a.txt", toolCallId: "fc-1", toolName: "edit", added: 1, removed: 0 },
    dirStep,
    ctx,
  );
  assertEqual(inside, null, "change inside the declared directory scope is clean");

  const exactStep = makeStep([{ path: "src/a.txt", operation: "modify" }]);
  const exact = await detectFileDeviation(
    { path: "src/a.txt", toolCallId: "fc-2", toolName: "edit", added: 0, removed: 1 },
    exactStep,
    ctx,
  );
  assertEqual(exact, null, "change of the declared exact file is clean");

  const caseInsensitive = await detectFileDeviation(
    { path: "SRC/A.TXT", toolCallId: "fc-3", toolName: "edit", added: 1, removed: 0 },
    exactStep,
    ctx,
  );
  assertEqual(caseInsensitive, null, "case-insensitive declared-file match is clean");

  const undeclared = await detectFileDeviation(
    { path: "out-of-scope.txt", toolCallId: "fc-4", toolName: "write", added: 1, removed: 0 },
    dirStep,
    ctx,
  );
  assert(undeclared !== null, "undeclared file change is a deviation");
  assertEqual(undeclared!.type, "file_out_of_scope", "deviation type");
  assertEqual(undeclared!.stepId, dirStep.stepId, "deviation bound to the step");
  assertEqual(undeclared!.toolCallId, "fc-4", "toolCallId preserved");

  const escaped = await detectFileDeviation(
    { path: "../outside.txt", toolCallId: "fc-5", toolName: "edit", added: 1, removed: 0 },
    dirStep,
    ctx,
  );
  assert(escaped !== null, "workspace escape is a deviation");
  assert(escaped!.reason.includes("outside the workspace"), "escape reason");

  const empty = await detectFileDeviation(
    { path: "", toolCallId: "fc-6", toolName: "edit", added: 1, removed: 0 },
    dirStep,
    ctx,
  );
  assertEqual(empty, null, "empty change path is diagnostic only, never judged");
});

await run("detectCommandDeviation: fixed match rule", async () => {
  const step = makeStep([], ["npm test"]);
  assertEqual(
    detectCommandDeviation("tc-1", "npm test", step),
    null,
    "exact match is clean",
  );
  assertEqual(
    detectCommandDeviation("tc-2", "npm test -- --coverage", step),
    null,
    "expected + whitespace prefix is clean",
  );
  const boundary = detectCommandDeviation("tc-3", "npm testx", step);
  assert(boundary !== null, "expected + non-whitespace suffix is a deviation (fixed prefix rule)");
  assertEqual(boundary!.command, "npm testx", "command preserved");
  const mismatch = detectCommandDeviation("tc-4", "rm -rf /", step);
  assert(mismatch !== null, "unexpected command is a deviation");
  assertEqual(mismatch!.type, "command_out_of_scope", "command deviation type");
  assertEqual(mismatch!.command, "rm -rf /", "command preserved");

  const noExpectation = makeStep([], []);
  const flagged = detectCommandDeviation("tc-5", "npm install", noExpectation);
  assert(flagged !== null, "step expecting no commands flags any command");
  assert(flagged!.reason.includes("expects no commands"), "no-commands reason");
});

await run("validatePlanDraft: valid draft and structural errors", async () => {
  const good = await validate(makeDraft());
  assertEqual(good.ok, true, "valid draft passes");
  assertEqual(good.errors.length, 0, "no field errors");

  const emptySteps = await validate({ ...makeDraft(), steps: [] });
  assertEqual(emptySteps.ok, false, "zero steps rejected");

  const tooMany = await validate({ ...makeDraft(), steps: Array.from({ length: 21 }, () => makeDraft().steps[0]) });
  assertEqual(tooMany.ok, false, "over-limit steps rejected");

  const dupKey = makeDraft();
  dupKey.steps[1].stepKey = "s0";
  const dup = await validate(dupKey);
  assertEqual(dup.ok, false, "duplicate stepKey rejected");
  assert(dup.errors.some((e) => e.includes("duplicate stepKey")), "duplicate field error");

  const badEnum = makeDraft();
  badEnum.steps[0].risk = "extreme" as never;
  const bad = await validate(badEnum);
  assertEqual(bad.ok, false, "invalid risk enum rejected");

  const noReason = makeDraft();
  noReason.steps[0].riskReason = "";
  const nr = await validate(noReason);
  assertEqual(nr.ok, false, "empty riskReason rejected");

  const badCommand = makeDraft();
  badCommand.steps[0].expectedCommands = [""];
  const bc = await validate(badCommand);
  assertEqual(bc.ok, false, "empty expected command rejected");
});

await run("validatePlanDraft: non-array steps and null step elements return fieldErrors", async () => {
  const nonArray = await validate({
    ...makeDraft(),
    steps: "not-an-array",
  } as unknown as SubmitUserPlanParams);
  assertEqual(nonArray.ok, false, "non-array steps rejected without throwing");
  assert(nonArray.errors.some((e) => e.includes("steps")), "non-array steps field error");

  const nullStep = await validate({ ...makeDraft(), steps: [null] } as unknown as SubmitUserPlanParams);
  assertEqual(nullStep.ok, false, "null step element rejected without throwing");
  assert(nullStep.errors.some((e) => e.includes("step entries must be objects")), "null step field error");

  const mixed = await validate({
    ...makeDraft(),
    steps: [null, makeDraft().steps[0]],
  } as unknown as SubmitUserPlanParams);
  assertEqual(mixed.ok, false, "null element among valid steps rejected without throwing");
  assert(mixed.errors.some((e) => e.includes("step entries must be objects")), "mixed null step field error");
});

await run("validatePlanDraft: DAG cycle, unknown and self dependencies", async () => {
  const cycle = makeDraft();
  cycle.steps[0].dependsOn = ["s1"];
  const c = await validate(cycle);
  assertEqual(c.ok, false, "cycle rejected");
  assert(c.errors.some((e) => e.includes("cycle")), "cycle field error");

  const unknown = makeDraft();
  unknown.steps[1].dependsOn = ["missing"];
  const u = await validate(unknown);
  assertEqual(u.ok, false, "unknown dependsOn rejected");

  const self = makeDraft();
  self.steps[0].dependsOn = ["s0"];
  const s = await validate(self);
  assertEqual(s.ok, false, "self-dependency rejected");
});

await run("validatePlanDraft: path semantics and 1.4.0 version gate", async () => {
  const absolute = makeDraft();
  absolute.steps[0].files = [{ path: join(PROJECT_CWD, "src", "a.txt"), operation: "read" }];
  const a = await validate(absolute);
  assertEqual(a.ok, false, "absolute path rejected");

  const glob = makeDraft();
  glob.steps[0].files = [{ path: "src/*.ts", operation: "read" }];
  const g = await validate(glob);
  assertEqual(g.ok, false, "glob path rejected");
  assert(g.errors.some((e) => e.includes("glob")), "glob field error");

  const escape = makeDraft();
  escape.steps[0].files = [{ path: "../escape.txt", operation: "read" }];
  const e = await validate(escape);
  assertEqual(e.ok, false, "workspace escape rejected");

  const badOperation = makeDraft();
  badOperation.steps[0].files = [{ path: "src/a.txt", operation: "chmod" as never }];
  const b = await validate(badOperation);
  assertEqual(b.ok, false, "invalid file operation rejected");

  const background = makeDraft();
  background.steps[1].executionTarget = "subagent_background";
  const bg = await validate(background);
  assertEqual(bg.ok, false, "subagent_background rejected in 1.4.0");
  assert(bg.errors.some((err) => err.includes("1.4.0")), "version gate field error");
});

await run("SubagentRunner: file_change forwarded through the service facade (1.4.1)", async () => {
  const stub = makeServiceStub();
  stub.scriptFileChange("out-of-scope.txt", "nested-write-1", "write");
  const harness = makeRunnerHarness(stub as unknown as AgentTaskService);
  const runner = new SubagentRunner(harness.ctx);
  const forwarded: Array<{ path: string | undefined; toolCallId: string }> = [];
  const details = await runner.run(
    { mode: "single", agentScope: "user", tasks: [{ prompt: "create out-of-scope.txt" }] },
    undefined,
    undefined,
    (event) => {
      forwarded.push({ path: event.change.path, toolCallId: event.change.toolCallId });
    },
  );
  assertEqual(details.results[0].status, "completed", "nested run completed");
  assert(forwarded.length >= 1, "file_change forwarded through the callback");
  assertEqual(forwarded[0].path, "out-of-scope.txt", "change path preserved");

  // The forwarded change feeds the unified deviation detector.
  const step = makeStep([{ path: "src/", operation: "modify" }]);
  const deviation = await detectFileDeviation(
    { path: forwarded[0].path!, toolCallId: forwarded[0].toolCallId, toolName: "write", added: 1, removed: 0 },
    step,
    pathContext(),
  );
  assert(deviation !== null, "forwarded nested change judged against the step scope");
  assertEqual(deviation!.type, "file_out_of_scope", "nested out-of-scope deviation");

  // Without the callback nothing is forwarded and behavior is unchanged.
  stub.scriptFileChange("src/b.txt", "nested-write-2", "write");
  const noCallback = await runner.run({ mode: "single", agentScope: "user", tasks: [{ prompt: "create src/b.txt" }] }, undefined);
  assertEqual(noCallback.results[0].status, "completed", "plain run completed without the callback");
  await runner.dispose();
});

await run("SessionBridge foreground adapter: subagent deviation returns in StepDelegateResult (1.4.1 service)", async () => {
  const bridge = new SessionBridge();
  await bridge.start(makeLocation());
  const generation = accessBridge(bridge)._generation!;
  const stub = makeServiceStub();
  accessBridge(bridge)._agentTaskService = stub;
  try {
    await bridge.setModel("faux", "faux-model");
    generation.modelRegistry.registerProvider("faux", { api: "faux-api", streamSimple: fauxStream });
    // The nested subagent (stubbed service) writes a file OUTSIDE the declared scope.
    stub.scriptFileChange("undeclared-e2e.txt", "nested-write-e2e", "write");
    const step = makeStep([{ path: "src/", operation: "modify" }], ["npm test"]);
    const link: PlanStepExecutionLink = { planId: "plan-e2e", version: 1, stepId: step.stepId };
    const result: StepDelegateResult = await accessBridge(bridge)._delegatePlanStep(step, link, "foreground");
    assertEqual(result.status, "result", "foreground delegation result");
    assert(Array.isArray(result.deviations), "deviations travel with the result");
    assert(result.deviations!.length >= 1, "out-of-scope nested write detected end-to-end");
    const deviation = result.deviations!.find((d) => d.path === "undeclared-e2e.txt");
    assert(deviation !== undefined, "deviation points at the nested write");
    assertEqual(deviation!.type, "file_out_of_scope", "deviation type file_out_of_scope");
    assertEqual(deviation!.toolCallId, "nested-write-e2e", "nested toolCallId preserved");

    // In-scope write stays clean.
    stub.scriptFileChange("src/inside.txt", "nested-write-inside", "write");
    const result2: StepDelegateResult = await accessBridge(bridge)._delegatePlanStep(step, link, "foreground");
    assertEqual(result2.status, "result", "second delegation result");
    assertEqual(result2.deviations!.length, 0, "in-scope nested write produces no deviation");
  } finally {
    await bridge.dispose();
  }
});

await run("SessionBridge foreground adapter: background presentation returns a group handle (1.4.1)", async () => {
  const bridge = new SessionBridge();
  await bridge.start(makeLocation());
  const stub = makeServiceStub();
  accessBridge(bridge)._agentTaskService = stub;
  try {
    const step = makeStep([{ path: "src/", operation: "modify" }]);
    const link: PlanStepExecutionLink = { planId: "plan-e2e", version: 1, stepId: step.stepId };
    const result: StepDelegateResult = await accessBridge(bridge)._delegatePlanStep(step, link, "background");
    assertEqual(result.status, "backgrounded", "background delegation returns backgrounded");
    assert(result.groupId !== undefined, "backgrounded result carries groupId");
    assertEqual(result.taskIds!.length, 1, "backgrounded result lists task ids");
  } finally {
    await bridge.dispose();
  }
});

// ============================================================================
// Private surface access (session-bridge-subagent.test.ts pattern)
// ============================================================================

interface GenerationAccess {
  _generation: {
    modelRegistry: ModelRegistry;
  };
}

interface BridgeAccess {
  _generation: {
    modelRegistry: ModelRegistry;
  };
  _agentTaskService: unknown;
  _delegatePlanStep: (
    step: PlanStep,
    link: PlanStepExecutionLink,
    presentation: "foreground" | "background",
  ) => Promise<StepDelegateResult>;
}

function accessBridge(bridge: SessionBridge): BridgeAccess {
  return bridge as unknown as BridgeAccess;
}

void (undefined as unknown as GenerationAccess);

// ============================================================================

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
