/**
 * SessionBridge subagent wiring tests (S4).
 *
 * Constructs the REAL SessionBridge directly (never ipc-handlers/preload, which
 * need the real Electron runtime) against a temp agent dir + faux provider and
 * verifies the solo wiring contract of design plan section 4.9: the effective
 * <sdk:agent> beats a same-name ordinary extension, team-leader has no PiX
 * agent tool, parent/nested registry identity and agentDir are same-source,
 * stale runner runtime/usage closures never read/write a replacement
 * parent/generation, project trust and the request_user_input approval path
 * both flow through the bridge FIFO, one active request at a time, exactly
 * once dismissals in the right order, defensive active snapshot, stale
 * generation/late response rejection, runner -> parent session -> parent MCP
 * close order, create/bind failure cleanup and resume usage rebuild.
 *
 * Run with: npx tsx src/main/__tests__/session-bridge-subagent.test.ts
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  ToolResultMessage,
  Usage,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  AgentSession,
  SessionManager,
  type RequestUserInputRequest,
  type RequestUserInputResponse,
} from "@earendil-works/pi-coding-agent";
import type { SubagentDetails } from "../../shared/subagent-types.js";
import { McpAdapter } from "pi-mcp-adapter";
import type { SubagentExecutionContext } from "../subagent/types.js";
import type { SubagentRunner } from "../subagent/subagent-runner.js";
import { SessionBridge } from "../session-bridge.js";
import type { ProjectLocation, RequestUserInputDismissal } from "../../shared/types.js";

// ============================================================================
// Test harness (matches subagent-runner.test.ts / execution-context.test.ts
// style)
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

/** Poll for a condition without relying on real timeouts. */
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

const AGENT_DIR = mkdtempSync(join(tmpdir(), "pix-bridge-agent-"));
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
const AGENTS_DIR = join(AGENT_DIR, "agents");
mkdirSync(AGENTS_DIR, { recursive: true });
const PROJECT_CWD = mkdtempSync(join(tmpdir(), "pix-bridge-project-"));

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

function writeProjectAgent(filename: string, frontmatter: string, body = "You are a project test agent."): void {
  mkdirSync(join(PROJECT_CWD, ".pi", "agents"), { recursive: true });
  writeFileSync(join(PROJECT_CWD, ".pi", "agents", filename), `---\n${frontmatter}\n---\n\n${body}`, "utf-8");
}

function clearProjectAgents(): void {
  rmSync(join(PROJECT_CWD, ".pi"), { recursive: true, force: true });
}

function makeLocation(): ProjectLocation {
  return {
    path: PROJECT_CWD,
    physicalPath: PROJECT_CWD,
    name: basename(PROJECT_CWD),
    environment: { kind: "windows" },
  };
}

// ============================================================================
// Private surface access (execution-context.test.ts casts the same way)
// ============================================================================

interface AuxiliaryTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

interface UserInputEntryAccess {
  request: RequestUserInputRequest;
  state: "queued" | "active" | "terminal";
}

interface GenerationAccess {
  genId: number;
  agentDir: string;
  authStorage: unknown;
  modelRegistry: {
    registerProvider: (name: string, config: unknown) => void;
  };
  auxiliaryUsage: AuxiliaryTotals;
  session: AgentSession | null;
  runner: SubagentRunner;
  mcpAdapter: { dispose: () => Promise<void> };
}

interface BridgeAccess {
  _session: AgentSession | null;
  _generation: GenerationAccess | null;
  _mcpAdapter: unknown;
  _userInputGeneration: number;
  _userInputQueueClosing: boolean;
  _userInputQueue: UserInputEntryAccess[];
  _activeUserInputEntry: UserInputEntryAccess | null;
  _auxiliaryUsage: AuxiliaryTotals;
}

function accessBridge(bridge: SessionBridge): BridgeAccess {
  return bridge as unknown as BridgeAccess;
}

interface RunnerAccess {
  _ctx: SubagentExecutionContext;
}

function accessRunnerCtx(runner: SubagentRunner): SubagentExecutionContext {
  return (runner as unknown as RunnerAccess)._ctx;
}

// ============================================================================
// Faux pi-ai provider (only needed by the parent approval test)
// ============================================================================

interface StreamScript {
  kind: "message";
  text?: string;
  usage?: Usage;
  stopReason?: "stop" | "error" | "aborted";
  toolCall?: { name: string; id: string; args: Record<string, unknown> };
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

function makeAssistantMessage(model: Model<Api>, script: StreamScript): AssistantMessage {
  const content: AssistantMessage["content"] = [];
  if (script.text) {
    content.push({ type: "text", text: script.text });
  }
  if (script.toolCall) {
    content.push({
      type: "toolCall",
      id: script.toolCall.id,
      name: script.toolCall.name,
      arguments: script.toolCall.args,
    });
  }
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: script.usage ?? zeroUsage(),
    stopReason: script.stopReason ?? "stop",
    timestamp: Date.now(),
  };
}

const providerScripts: StreamScript[] = [];

function fauxStream(model: Model<Api>, _context: Context, _options?: SimpleStreamOptions): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const script = providerScripts.shift() ?? { kind: "message" as const, text: "", stopReason: "stop" as const };
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
// Unhandled rejection collector
// ============================================================================

const unhandledRejections: unknown[] = [];
process.on("unhandledRejection", (reason: unknown) => {
  unhandledRejections.push(reason);
});

function assertNoUnhandledRejections(): void {
  assertEqual(unhandledRejections.length, 0, "no unhandled rejections observed");
  unhandledRejections.length = 0;
}

// ============================================================================
// Tests
// ============================================================================

await run("solo mounts <sdk:agent> winning over a same-name extension; team-leader has no PiX agent tool", async () => {
  const extPath = join(AGENT_DIR, "shadow-agent.ts");
  writeFileSync(
    extPath,
    [
      'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";',
      'import { Type } from "typebox";',
      "",
      "export default function activate(pi: ExtensionAPI): void {",
      "  pi.registerTool({",
      '    name: "agent",',
      '    label: "Shadow Agent",',
      '    description: "A fake agent tool that must be shadowed by the SDK custom tool",',
      "    parameters: Type.Object({}),",
      '    execute: async () => ({ content: [{ type: "text", text: "shadow" }], details: {} }),',
      "  });",
      "  pi.registerTool({",
      '    name: "shadow-ext-tool",',
      '    label: "Shadow Ext",',
      '    description: "A marker tool proving the extension loaded",',
      "    parameters: Type.Object({}),",
      '    execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),',
      "  });",
      "}",
    ].join("\n"),
    "utf-8",
  );
  writeFileSync(join(AGENT_DIR, "settings.json"), JSON.stringify({ extensions: [extPath] }), "utf-8");

  try {
    const solo = new SessionBridge();
    await solo.start(makeLocation());
    const session = accessBridge(solo)._session!;
    const agentTool = session.getAllTools().find((tool) => tool.name === "agent");
    assert(agentTool !== undefined, "solo parent has an effective agent tool");
    assertEqual(agentTool!.sourceInfo.path, "<sdk:agent>", "effective agent tool comes from <sdk:agent>");
    assertEqual(agentTool!.sourceInfo.source, "sdk", "effective agent tool source is sdk (wins over the extension)");
    assert(session.getActiveToolNames().includes("agent"), "the sdk:agent tool is active");
    assert(session.getAllTools().some((tool) => tool.name === "shadow-ext-tool"), "ordinary extension tools still load");
    await solo.dispose();

    const leader = new SessionBridge({ role: "team-leader" });
    await leader.start(makeLocation());
    const leaderSession = accessBridge(leader)._session!;
    const leaderAgent = leaderSession.getAllTools().find((tool) => tool.name === "agent");
    assert(leaderAgent !== undefined, "team-leader still loads the ordinary extension's own agent tool");
    assert(leaderAgent!.sourceInfo.source !== "sdk", "team-leader has NO <sdk:agent> PiX agent tool");
    assertEqual(accessBridge(leader)._generation, null, "team-leader creates no subagent generation/runner");
    await leader.dispose();
  } finally {
    rmSync(join(AGENT_DIR, "settings.json"), { force: true });
    rmSync(extPath, { force: true });
  }
  assertNoUnhandledRejections();
});

await run("parent/nested registry identity and agentDir are same-source", async () => {
  const bridge = new SessionBridge();
  await bridge.start(makeLocation());
  const b = accessBridge(bridge);
  const generation = b._generation!;
  const session = b._session!;
  try {
    assert(
      generation.modelRegistry === (session as unknown as { modelRegistry: unknown }).modelRegistry,
      "parent session uses the generation's ModelRegistry identity (no SDK-created second registry)",
    );
    assertEqual(generation.agentDir, AGENT_DIR, "generation agentDir is the resolved getAgentDir()");
    assertEqual(generation.genId, b._userInputGeneration, "current generation is the live one");

    // The runner context borrows the same registry identity and agentDir.
    const runnerCtx = accessRunnerCtx(generation.runner);
    assert(
      runnerCtx.modelRegistry === (session as unknown as { modelRegistry: unknown }).modelRegistry,
      "runner context borrows the same registry identity as the parent session",
    );
    assertEqual(runnerCtx.agentDir, generation.agentDir, "runner context agentDir === generation agentDir");
    assert(runnerCtx.authStorage === generation.authStorage, "runner context borrows the generation auth storage");
  } finally {
    await bridge.dispose();
  }
  assertNoUnhandledRejections();
});

await run("stale runner closures never read or write a replacement parent/generation", async () => {
  const bridge = new SessionBridge();
  await bridge.start(makeLocation());
  const b = accessBridge(bridge);
  const gen1 = b._generation!;
  const ctx1 = accessRunnerCtx(gen1.runner);
  try {
    await bridge.setModel("faux", "faux-model");
    const snapshot1 = ctx1.getParentRuntime();
    assertEqual(snapshot1.model?.id, "faux-model", "generation 1 parent runtime model captured");

    // Replacement: newSession closes gen1 and opens gen2 with its own parent.
    await bridge.newSession();
    const gen2 = accessBridge(bridge)._generation!;
    assert(gen2 !== gen1, "replacement owns a new generation record");
    assertEqual(gen2.genId, accessBridge(bridge)._userInputGeneration, "replacement generation is the live one");
    await bridge.setModel("faux", "x/y");
    assertEqual(accessBridge(bridge)._session!.model?.id, "x/y", "session 2 model switched");

    // A stale runner's late getParentRuntime call must still read generation 1's
    // own parent session, never the replacement session.
    const snapshot1Late = ctx1.getParentRuntime();
    assertEqual(snapshot1Late.model?.id, "faux-model", "stale getParentRuntime reads generation 1's parent, never the replacement");
    const snapshot2 = accessRunnerCtx(gen2.runner).getParentRuntime();
    assertEqual(snapshot2.model?.id, "x/y", "generation 2 getParentRuntime reads its own parent");

    // Usage closures are generation-bound: a stale runner's late usage write
    // must land in its own accumulator, never the replacement session's.
    ctx1.recordAuxiliaryUsage({ input: 100, output: 40, cacheRead: 5, cacheWrite: 1, totalTokens: 146, cost: 2, turns: 1 });
    accessRunnerCtx(gen2.runner).recordAuxiliaryUsage({ input: 7, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 7, cost: 0, turns: 0 });
    assertEqual(gen1.auxiliaryUsage.input, 100, "stale runner usage lands in generation 1's accumulator");
    assertEqual(gen2.auxiliaryUsage.input, 7, "replacement usage lands in generation 2's accumulator");
    assertEqual(gen1.auxiliaryUsage.cost, 2, "stale runner cost lands in generation 1's accumulator");
    assertEqual(gen2.auxiliaryUsage.cost, 0, "replacement cost lands in generation 2's accumulator");
    // The bridge stats reference points at the ACTIVE generation's accumulator.
    assert(
      accessBridge(bridge)._auxiliaryUsage === gen2.auxiliaryUsage,
      "bridge stats reference points at the active generation's accumulator",
    );
    assertEqual(accessBridge(bridge)._auxiliaryUsage.input, 7, "getSessionStats reads only the active generation's usage");
  } finally {
    await bridge.dispose();
  }
  assertNoUnhandledRejections();
});

await run("project trust and concurrent requests: one active at a time through the bridge FIFO", async () => {
  writeProjectAgent("scout.md", "name: scout\ndescription: scout agent");
  try {
    const bridge = new SessionBridge();
    await bridge.start(makeLocation());
    const b = accessBridge(bridge);
    const runner = b._generation!.runner;
    await bridge.setModel("faux", "faux-model");

    const emitted: RequestUserInputRequest[] = [];
    const dismissals: RequestUserInputDismissal[] = [];
    const offRequest = bridge.onUserInputRequest((request) => emitted.push(request));
    const offDismissed = bridge.onUserInputDismissed((dismissal) => dismissals.push(dismissal));
    try {
      // Two concurrent runs both resolve a project agent -> two trust requests
      // share the SAME bridge FIFO (runner requestUserInput closure).
      const run1 = runner.run(
        { mode: "single", agentScope: "both", tasks: [{ subagent_type: "scout", prompt: "task one" }] },
        undefined,
      );
      const run2 = runner.run(
        { mode: "single", agentScope: "both", tasks: [{ subagent_type: "scout", prompt: "task two" }] },
        undefined,
      );
      await waitFor(() => emitted.length >= 1, 20000, "first request emitted");
      assertEqual(emitted.length, 1, "only the queue head is emitted while the first request is active");
      assertEqual(b._userInputQueue.length, 1, "second request is queued (invisible to the renderer)");

      // The active snapshot exposes a defensive copy of ONLY the active request.
      const snapshot = bridge.getActiveUserInputRequest();
      assert(snapshot !== null, "active snapshot exists");
      assertEqual(snapshot!.id, emitted[0]!.id, "active snapshot matches the head id");
      assertEqual(snapshot!.questions[0]!.question, emitted[0]!.questions[0]!.question, "snapshot question is a plain copy");
      assert(snapshot!.questions[0] !== emitted[0]!.questions[0], "snapshot does not share nested question references");
      assert(snapshot!.id !== b._userInputQueue[0]!.request.id, "snapshot never leaks the queued request");

      // A duplicate id is rejected without any emit.
      let duplicateError: string | undefined;
      const runnerCtx = accessRunnerCtx(runner);
      await runnerCtx
        .requestUserInput({ id: emitted[0]!.id, questions: [{ id: "q", header: "H", question: "Q" }] }, undefined)
        .catch((err: unknown) => {
          duplicateError = String(err);
        });
      assertEqual(duplicateError !== undefined, true, "duplicate active id rejects immediately");
      assertEqual(emitted.length, 1, "duplicate id emits no request");
      assertEqual(dismissals.length, 0, "duplicate id emits no dismissal");

      // A pre-aborted signal rejects immediately without any emit.
      const abortedController = new AbortController();
      abortedController.abort();
      let abortedError: string | undefined;
      await runnerCtx
        .requestUserInput(
          { id: "pre-aborted", questions: [{ id: "q", header: "H", question: "Q" }] },
          abortedController.signal,
        )
        .catch((err: unknown) => {
          abortedError = String(err);
        });
      assertEqual(abortedError !== undefined, true, "pre-aborted signal rejects immediately");
      assertEqual(emitted.length, 1, "pre-aborted signal emits no request");

      // Response settles ONLY the active id; no dismissal; then the queue pumps.
      const firstId = emitted[0]!.id;
      assertEqual(
        bridge.respondUserInput({ id: firstId, answers: { allow_project_agents: "拒绝" } }),
        true,
        "response for the active id settles",
      );
      assertEqual(
        bridge.respondUserInput({ id: "never-seen", answers: {} }),
        false,
        "unknown id returns false without throwing",
      );
      assertEqual(dismissals.length, 0, "a response never emits a dismissal");
      await waitFor(() => emitted.length >= 2, 20000, "second request emitted after the pump");
      assertEqual(emitted.length, 2, "FIFO pumps the next request after the response");
      assertEqual(bridge.getActiveUserInputRequest()?.id, emitted[1]!.id, "snapshot now exposes the second active request");

      const run1Result = await run1;
      assertEqual(run1Result.results[0]?.failureReason, "project_agent_denied", "denied project trust aborts the run");

      // Deny the second too; both runs settle through the same queue.
      assertEqual(
        bridge.respondUserInput({ id: emitted[1]!.id, answers: { allow_project_agents: "拒绝" } }),
        true,
        "second response settles",
      );
      const run2Result = await run2;
      assertEqual(run2Result.results[0]?.failureReason, "project_agent_denied", "second denied project trust aborts the run");
      assertEqual(dismissals.length, 0, "no dismissals in the whole response-driven flow");
    } finally {
      offRequest();
      offDismissed();
      await bridge.dispose();
    }
  } finally {
    clearProjectAgents();
  }
  assertNoUnhandledRejections();
});

await run("active abort dismisses then pumps; queued abort never dismisses", async () => {
  writeProjectAgent("scout.md", "name: scout\ndescription: scout agent");
  try {
    const bridge = new SessionBridge();
    await bridge.start(makeLocation());
    const runner = accessBridge(bridge)._generation!.runner;
    await bridge.setModel("faux", "faux-model");

    // Combined event order proves dismissal always precedes the following
    // request in listener invocation.
    const order: string[] = [];
    const emitted: RequestUserInputRequest[] = [];
    const dismissals: RequestUserInputDismissal[] = [];
    bridge.onUserInputRequest((request) => {
      emitted.push(request);
      order.push(`request:${request.id}`);
    });
    bridge.onUserInputDismissed((dismissal) => {
      dismissals.push(dismissal);
      order.push(`dismissed:${dismissal.id}`);
    });

    const controller1 = new AbortController();
    const controller2 = new AbortController();
    const controller3 = new AbortController();
    const run1 = runner.run(
      { mode: "single", agentScope: "both", tasks: [{ subagent_type: "scout", prompt: "a" }] },
      controller1.signal,
    );
    const run2 = runner.run(
      { mode: "single", agentScope: "both", tasks: [{ subagent_type: "scout", prompt: "b" }] },
      controller2.signal,
    );
    const run3 = runner.run(
      { mode: "single", agentScope: "both", tasks: [{ subagent_type: "scout", prompt: "c" }] },
      controller3.signal,
    );
    await waitFor(() => emitted.length === 1, 20000, "first request emitted");
    const firstId = emitted[0]!.id;
    assertEqual(dismissals.length, 0, "no dismissals while a request is merely displayed");

    // Abort the QUEUED request: removed + rejected only, never displayed so
    // never dismissed, and the active request stays active.
    controller2.abort();
    await waitFor(() => dismissals.length === 0 && accessBridge(bridge)._userInputQueue.length === 1, 20000, "queued abort removed");
    assertEqual(dismissals.length, 0, "queued abort emits no dismissal");
    assertEqual(emitted.length, 1, "queued abort does not pump anything");
    assertEqual(bridge.getActiveUserInputRequest()?.id, firstId, "active request unchanged after the queued abort");
    const run2Result = await run2;
    assertEqual(run2Result.results[0]?.status, "aborted", "queued-aborted run settles as aborted");

    // Abort the ACTIVE request: exactly-once dismissal, then pump the next.
    controller1.abort();
    await waitFor(() => dismissals.length >= 1, 20000, "active abort dismissal");
    assertEqual(dismissals.length, 1, "active abort dismisses exactly once");
    assertEqual(dismissals[0]!.id, firstId, "active abort dismisses the displayed id");
    assertEqual(dismissals[0]!.reason, "aborted", "active abort dismissal reason is aborted");
    await waitFor(() => emitted.length >= 2, 20000, "next request emitted after the active abort");
    assertEqual(emitted.length, 2, "pump happens after the active abort dismissal");
    const secondId = emitted[1]!.id;
    assert(
      order.indexOf(`dismissed:${firstId}`) < order.indexOf(`request:${secondId}`),
      "dismissal listener invocation precedes the following request",
    );
    assertEqual(accessBridge(bridge)._userInputQueue.length, 0, "queue empty after the pump");

    const run1Result = await run1;
    assertEqual(run1Result.results[0]?.status, "aborted", "active-aborted run settles as aborted");

    // Settle the last request normally; no dismissal for it either.
    assertEqual(
      bridge.respondUserInput({ id: secondId, answers: { allow_project_agents: "拒绝" } }),
      true,
      "final response settles",
    );
    const run3Result = await run3;
    assertEqual(run3Result.results[0]?.failureReason, "project_agent_denied", "third run settles via the response path");
    assertEqual(dismissals.length, 1, "still exactly one dismissal in the whole flow");
    await bridge.dispose();
  } finally {
    clearProjectAgents();
  }
  assertNoUnhandledRejections();
});

await run("close dismisses only the displayed item and rejects the whole queue", async () => {
  writeProjectAgent("scout.md", "name: scout\ndescription: scout agent");
  try {
    const bridge = new SessionBridge();
    await bridge.start(makeLocation());
    const runner = accessBridge(bridge)._generation!.runner;
    await bridge.setModel("faux", "faux-model");

    const emitted: RequestUserInputRequest[] = [];
    const dismissals: RequestUserInputDismissal[] = [];
    bridge.onUserInputRequest((request) => emitted.push(request));
    bridge.onUserInputDismissed((dismissal) => dismissals.push(dismissal));

    const run1 = runner.run(
      { mode: "single", agentScope: "both", tasks: [{ subagent_type: "scout", prompt: "a" }] },
      undefined,
    );
    const run2 = runner.run(
      { mode: "single", agentScope: "both", tasks: [{ subagent_type: "scout", prompt: "b" }] },
      undefined,
    );
    await waitFor(() => emitted.length === 1, 20000, "first request emitted");
    await waitFor(() => accessBridge(bridge)._userInputQueue.length === 1, 20000, "second request queued");
    const firstId = emitted[0]!.id;

    await bridge.dispose();
    assertEqual(dismissals.length, 1, "close dismisses exactly once");
    assertEqual(dismissals[0]!.id, firstId, "close dismisses the displayed item only");
    assertEqual(dismissals[0]!.reason, "session_closed", "close dismissal reason is session_closed");
    assertEqual(emitted.length, 1, "no new request is ever pumped after close");
    assertEqual(bridge.getActiveUserInputRequest(), null, "no active snapshot after close");
    assertEqual(
      bridge.respondUserInput({ id: firstId, answers: {} }),
      false,
      "late response after close returns false (no IPC error)",
    );

    const run1Result = await run1;
    const run2Result = await run2;
    assertEqual(run1Result.results[0]?.status, "aborted", "active approval rejected by close is aborted");
    assertEqual(run1Result.results[0]?.failureReason, "host_disposed", "close-driven rejection is host_disposed, never a user denial");
    assertEqual(run2Result.results[0]?.status, "aborted", "queued approval rejected by close is aborted");
  } finally {
    clearProjectAgents();
  }
  assertNoUnhandledRejections();
});

await run("stale-generation request emits nothing", async () => {
  const bridge = new SessionBridge();
  await bridge.start(makeLocation());
  const b = accessBridge(bridge);
  const ctx1 = accessRunnerCtx(b._generation!.runner);
  const staleClosure = ctx1.requestUserInput;

  const emitted: RequestUserInputRequest[] = [];
  const dismissals: RequestUserInputDismissal[] = [];
  bridge.onUserInputRequest((request) => emitted.push(request));
  bridge.onUserInputDismissed((dismissal) => dismissals.push(dismissal));

  try {
    // Replace the session: the old generation's queue is closed and its
    // generation invalidated. The new generation reopens the queue.
    await bridge.newSession();
    assertEqual(accessBridge(bridge)._userInputQueueClosing, false, "new generation reopens the queue");

    let staleError: string | undefined;
    await staleClosure(
      { id: "stale-req", questions: [{ id: "q", header: "H", question: "Q" }] },
      undefined,
    ).catch((err: unknown) => {
      staleError = String(err);
    });
    assertEqual(staleError !== undefined, true, "stale-generation request rejects");
    assertEqual(emitted.length, 0, "stale-generation request emits no request");
    assertEqual(dismissals.length, 0, "stale-generation request emits no dismissal");
    assertEqual(bridge.getActiveUserInputRequest(), null, "no active snapshot from the stale generation");
  } finally {
    await bridge.dispose();
  }
  assertNoUnhandledRejections();
});

await run("close order: runner -> parent session -> parent MCP", async () => {
  const bridge = new SessionBridge();
  await bridge.start(makeLocation());
  const b = accessBridge(bridge);
  const generation = b._generation!;
  const session = b._session!;

  const order: string[] = [];
  const runner = generation.runner as unknown as { dispose: () => Promise<void> };
  const origRunnerDispose = runner.dispose;
  runner.dispose = () => {
    order.push("runner");
    return origRunnerDispose.call(generation.runner);
  };
  const sessionAccess = session as unknown as { dispose: () => Promise<void> };
  const origSessionDispose = sessionAccess.dispose;
  sessionAccess.dispose = () => {
    order.push("session");
    return origSessionDispose.call(session);
  };
  const mcpAccess = generation.mcpAdapter as unknown as { dispose: () => Promise<void> };
  const origMcpDispose = mcpAccess.dispose;
  mcpAccess.dispose = () => {
    order.push("mcp");
    return origMcpDispose.call(generation.mcpAdapter);
  };

  await bridge.dispose();
  assertEqual(order.join("->"), "runner->session->mcp", "dispose order is runner, parent session, parent MCP");
  assertEqual(order.length, 3, "all three owned objects disposed");
  assertEqual(accessBridge(bridge)._generation, null, "generation cleared after close");
  assertEqual(accessBridge(bridge)._session, null, "session cleared after close");
  assertEqual(accessBridge(bridge)._mcpAdapter, null, "MCP adapter cleared after close");
  assertEqual(accessBridge(bridge)._userInputQueueClosing, true, "input queue left closing after close");
  assertNoUnhandledRejections();
});

await run("create/bind failure leaves no leaks", async () => {
  const disposedSessions: AgentSession[] = [];
  const disposedMcps: unknown[] = [];
  const origBind = AgentSession.prototype.bindExtensions;
  const origSessionDispose = AgentSession.prototype.dispose;
  const origMcpDispose = McpAdapter.prototype.dispose;
  let failBind = true;

  (AgentSession.prototype as {
    bindExtensions: (bindings: Parameters<AgentSession["bindExtensions"]>[0]) => Promise<unknown>;
  }).bindExtensions = async function (this: AgentSession, bindings: Parameters<AgentSession["bindExtensions"]>[0]) {
    if (failBind) {
      throw new Error("bind failed");
    }
    return origBind.call(this, bindings);
  };
  (AgentSession.prototype as { dispose: () => Promise<void> }).dispose = function (this: AgentSession) {
    disposedSessions.push(this);
    return origSessionDispose.call(this);
  };
  (McpAdapter.prototype as { dispose: () => Promise<void> }).dispose = function (this: McpAdapter) {
    disposedMcps.push(this);
    return origMcpDispose.call(this);
  };

  try {
    const bridge = new SessionBridge();
    let startError: string | undefined;
    try {
      await bridge.start(makeLocation());
    } catch (err) {
      startError = err instanceof Error ? err.message : String(err);
    }
    assertEqual(startError, "bind failed", "start rejects when bindExtensions throws");
    const b = accessBridge(bridge);
    assertEqual(b._generation, null, "generation cleared after activation failure");
    assertEqual(b._session, null, "session cleared after activation failure");
    assertEqual(b._mcpAdapter, null, "MCP adapter cleared after activation failure");
    assertEqual(b._userInputQueueClosing, true, "input queue closed after activation failure");
    assertEqual(bridge.getActiveUserInputRequest(), null, "no active request after failure");
    assertEqual(disposedSessions.length, 1, "the created candidate session was disposed");
    assertEqual(disposedMcps.length, 1, "the created MCP adapter was disposed");

    // A fresh start with bind working again succeeds (queue reopened by the
    // new generation) and the bridge is fully usable.
    failBind = false;
    await bridge.start(makeLocation());
    assert(accessBridge(bridge)._session !== null, "bridge recovers with a new session");
    assertEqual(accessBridge(bridge)._userInputQueueClosing, false, "new generation reopens the input queue");
    await bridge.dispose();
  } finally {
    (AgentSession.prototype as {
      bindExtensions: (bindings: Parameters<AgentSession["bindExtensions"]>[0]) => Promise<unknown>;
    }).bindExtensions = origBind;
    (AgentSession.prototype as { dispose: () => Promise<void> }).dispose = origSessionDispose;
    (McpAdapter.prototype as { dispose: () => Promise<void> }).dispose = origMcpDispose;
  }
  assertNoUnhandledRejections();
});

await run("parent request_user_input approval flows through the same bridge FIFO", async () => {
  const bridge = new SessionBridge();
  await bridge.start(makeLocation());
  const b = accessBridge(bridge);
  const registry = b._generation!.modelRegistry;
  const session = b._session!;
  try {
    await bridge.setModel("faux", "faux-model");

    // Wire the faux provider on the SAME pi-ai instance the parent session's
    // streamFn dispatches through (registry.registerProvider wires through its
    // own api-registry, matching the S2 runner harness).
    registry.registerProvider("faux", { api: "faux-api", streamSimple: fauxStream });

    providerScripts.length = 0;
    providerScripts.push({
      kind: "message",
      stopReason: "stop",
      toolCall: {
        name: "request_user_input",
        id: "call_ui_1",
        args: { questions: [{ id: "q1", header: "H1", question: "Approve this?" }] },
      },
    });
    providerScripts.push({ kind: "message", text: "done", stopReason: "stop" });

    const emitted: RequestUserInputRequest[] = [];
    const dismissals: RequestUserInputDismissal[] = [];
    bridge.onUserInputRequest((request) => emitted.push(request));
    bridge.onUserInputDismissed((dismissal) => dismissals.push(dismissal));

    const requestReceived = new Promise<RequestUserInputRequest>((resolve) => {
      const off = bridge.onUserInputRequest((request) => {
        off();
        resolve(request);
      });
    });

    const promptPromise = session.prompt("Ask me something");
    const request = await requestReceived;
    assertEqual(emitted.length, 1, "parent request_user_input emits through the bridge queue");
    assertEqual(request.questions[0]!.id, "q1", "approval question id preserved");
    assertEqual(dismissals.length, 0, "no dismissal while the approval is displayed");

    // The parent approval settles through the SAME respondUserInput surface as
    // project trust; the tool then completes and the turn finishes.
    assertEqual(bridge.respondUserInput({ id: request.id, answers: { q1: "yes" } }), true, "parent approval response settles");
    await promptPromise;
    assertEqual(emitted.length, 1, "no further requests in this turn");
    assertEqual(dismissals.length, 0, "no dismissal in the approval flow");
    assertEqual(bridge.getActiveUserInputRequest(), null, "no active request after the approval settled");
  } finally {
    await bridge.dispose();
  }
  assertNoUnhandledRejections();
});

await run("resume usage rebuilds from persisted agent tool result details", async () => {
  const sessionManager = SessionManager.create(PROJECT_CWD);
  sessionManager.appendModelChange("faux", "faux-model");
  sessionManager.appendThinkingLevelChange("off");
  sessionManager.appendMessage({ role: "user", content: "do it", timestamp: Date.now() });
  sessionManager.appendMessage({
    role: "assistant",
    content: [
      { type: "text", text: "delegating" },
      { type: "toolCall", id: "call_1", name: "agent", arguments: { prompt: "go" } },
    ],
    api: "faux-api",
    provider: "faux",
    model: "faux-model",
    usage: zeroUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  } as AssistantMessage);

  const validDetails: SubagentDetails = {
    schemaVersion: 1,
    mode: "single",
    agentScope: "user",
    results: [
      {
        id: "r1",
        index: 0,
        agentName: "general-purpose",
        agentSource: "built-in",
        description: "go",
        status: "completed",
        finalOutput: "done",
        outputTruncated: false,
        originalOutputBytes: 4,
        toolUseCount: 1,
        activities: [],
        usage: { input: 50, output: 30, cacheRead: 10, cacheWrite: 5, totalTokens: 95, cost: 0.4, turns: 2 },
        startedAt: 1,
        endedAt: 2,
        durationMs: 1,
      },
    ],
    startedAt: 1,
    updatedAt: 2,
    durationMs: 1,
  };
  sessionManager.appendMessage({
    role: "toolResult",
    toolCallId: "call_1",
    toolName: "agent",
    content: [{ type: "text", text: "done" }],
    details: validDetails,
    isError: false,
    timestamp: Date.now(),
  } as ToolResultMessage);
  // An invalid details payload must be skipped by the type guard.
  sessionManager.appendMessage({
    role: "toolResult",
    toolCallId: "call_2",
    toolName: "agent",
    content: [{ type: "text", text: "bad" }],
    details: { schemaVersion: 99 },
    isError: false,
    timestamp: Date.now(),
  } as unknown as ToolResultMessage);

  const bridge = new SessionBridge();
  await bridge.start(makeLocation());
  const b = accessBridge(bridge);
  try {
    const session = b._session!;
    assertEqual(
      session.messages.filter((message) => message.role === "toolResult").length,
      2,
      "resumed session restored the agent tool results",
    );
    const usage = b._generation!.auxiliaryUsage;
    assertEqual(usage.input, 50, "resume rebuild aggregated input");
    assertEqual(usage.output, 30, "resume rebuild aggregated output");
    assertEqual(usage.cacheRead, 10, "resume rebuild aggregated cacheRead");
    assertEqual(usage.cacheWrite, 5, "resume rebuild aggregated cacheWrite");
    assertEqual(usage.cost, 0.4, "resume rebuild aggregated cost");
    assert(b._auxiliaryUsage === usage, "resume rebuild wrote the same generation-bound accumulator as live usage");
    assert(
      bridge.getSessionStats().tokens.input >= 50,
      "resume-rebuilt usage is included in the session stats",
    );
  } finally {
    await bridge.dispose();
  }
  assertNoUnhandledRejections();
});

// ============================================================================

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
