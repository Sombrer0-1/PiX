/**
 * SessionBridge workflow wiring tests (S8 + S10).
 *
 * Constructs the REAL SessionBridge directly (never ipc-handlers/preload, which
 * need the real Electron runtime) against a temp agent dir + faux provider and
 * verifies the solo workflow wiring contract of design plan sections 2.6 / 4.8:
 * solo customTools mount `workflow` / `ralph` (team-leader mounts neither), the
 * generation owns a WorkerThreadWorkflowEngine + WorkflowRecorder exposed via
 * getWorkflowRecorder(), BOTH close paths (_closeCurrentSession AND
 * _disposeCandidateRuntime) run workflowEngine.disposeAll() BEFORE
 * detachForegroundGroupsForSession (locked close order), candidate disposal
 * also calls disposeAll, and the recorder lifecycle callback is the only
 * productEventCollector.record source for workflow runs (V143 names, payload
 * limited to status/durationMs/counts).
 *
 * S10: getParentRef carries workspaceIdOf(cwd); engine config.cache is a
 * WorkflowChildCache whose rootDir is join(getAgentDir(), "workflow-cache").
 *
 * Run with: npx tsx src/main/__tests__/workflow-session-bridge.test.ts
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { AgentSession, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ProductEvent } from "../../shared/product-events.js";
import type { ProjectLocation } from "../../shared/types.js";
import { WorkflowRunId } from "../../shared/workflow-types.js";
import { AgentTaskStore } from "../agent-task/agent-task-store.js";
import { AgentTaskService } from "../agent-task/agent-task-service.js";
import { workspaceIdOf } from "../agent-task/agent-task-identity.js";
import type { ProductEventCollector } from "../product-event-collector.js";
import { SettingsStore } from "../settings-store.js";
import type { PlanController } from "../plan/plan-controller.js";
import type { WorkflowRecorder } from "../workflow/recorder.js";
import { WorkflowChildCache } from "../workflow/child-cache.js";
import type { WorkflowStartRequest } from "../workflow/engine/index.js";
import { WorkerThreadWorkflowEngine } from "../workflow/engine/index.js";
import { SessionBridge } from "../session-bridge.js";

// ============================================================================
// Test harness (matches session-bridge-subagent.test.ts style)
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

// ============================================================================
// Shared temp environment (agentDir + project cwd)
// ============================================================================

const AGENT_DIR = mkdtempSync(join(tmpdir(), "pix-wf-bridge-agent-"));
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
const AGENTS_DIR = join(AGENT_DIR, "agents");
mkdirSync(AGENTS_DIR, { recursive: true });
const PROJECT_CWD = mkdtempSync(join(tmpdir(), "pix-wf-bridge-project-"));

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

writeFileSync(join(AGENT_DIR, "models.json"), JSON.stringify(MODELS_JSON, null, 2), "utf-8");

function makeLocation(cwd: string = PROJECT_CWD): ProjectLocation {
  return {
    path: cwd,
    physicalPath: cwd,
    name: basename(cwd),
    environment: { kind: "windows" },
  };
}

// ============================================================================
// Private surface access (session-bridge-subagent.test.ts casts the same way)
// ============================================================================

interface GenerationAccess {
  genId: number;
  session: AgentSession | null;
  runner: { dispose: () => Promise<void> };
  planController: PlanController;
  mcpAdapter: { dispose: () => Promise<void> };
  workflowEngine: WorkerThreadWorkflowEngine;
  workflowRecorder: WorkflowRecorder;
}

interface BridgeAccess {
  _session: AgentSession | null;
  _generation: GenerationAccess | null;
  _mcpAdapter: unknown;
}

function accessBridge(bridge: SessionBridge): BridgeAccess {
  return bridge as unknown as BridgeAccess;
}

// ============================================================================
// Faux app-level AgentTaskService (mirrors session-bridge-subagent.test.ts)
// ============================================================================

function makeTaskService(): AgentTaskService {
  const cwd = mkdtempSync(join(tmpdir(), "pix-wf-bridge-task-service-"));
  const settings = new SettingsStore({ cwd });
  const events = { record: () => {} } as unknown as ProductEventCollector;
  const store = new AgentTaskStore({
    rootDir: mkdtempSync(join(tmpdir(), "pix-wf-bridge-task-store-")),
    maxTaskBytes: 25 * 1024 * 1024,
    maxWorkspaceBytes: 500 * 1024 * 1024,
  });
  return new AgentTaskService({ settings, events, store, runId: "wf-bridge-run" });
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

await run("solo customTools mount workflow/ralph (sdk); team-leader mounts neither; generation exposes engine+recorder", async () => {
  const bridge = new SessionBridge({ agentTaskService: makeTaskService() });
  await bridge.start(makeLocation());
  const b = accessBridge(bridge);
  const generation = b._generation!;
  try {
    const session = b._session!;
    const workflowTool = session.getAllTools().find((tool) => tool.name === "workflow");
    const ralphTool = session.getAllTools().find((tool) => tool.name === "ralph");
    assert(workflowTool !== undefined, "solo parent has a workflow tool");
    assert(ralphTool !== undefined, "solo parent has a ralph tool");
    assertEqual(workflowTool!.sourceInfo.path, "<sdk:workflow>", "workflow tool is an SDK custom tool");
    assertEqual(ralphTool!.sourceInfo.path, "<sdk:ralph>", "ralph tool is an SDK custom tool");
    assertEqual(workflowTool!.sourceInfo.source, "sdk", "workflow tool source is sdk");
    assert(session.getActiveToolNames().includes("workflow"), "the workflow tool is active");
    assert(session.getActiveToolNames().includes("ralph"), "the ralph tool is active");

    assert(generation.workflowEngine instanceof WorkerThreadWorkflowEngine, "generation owns a worker-thread workflow engine");
    assert(generation.workflowRecorder !== undefined, "generation owns a workflow recorder");
    assert(bridge.getWorkflowRecorder() === generation.workflowRecorder, "getWorkflowRecorder() exposes the generation recorder");
  } finally {
    await bridge.dispose();
  }
  assertNoUnhandledRejections();

  // Team-leader: same project, no generation, no workflow tools.
  const leader = new SessionBridge({ role: "team-leader", agentTaskService: makeTaskService() });
  await leader.start(makeLocation());
  try {
    const leaderSession = accessBridge(leader)._session!;
    const leaderNames = leaderSession.getAllTools().map((tool) => tool.name);
    assert(!leaderNames.includes("workflow"), "team-leader has NO workflow tool");
    assert(!leaderNames.includes("ralph"), "team-leader has NO ralph tool");
    assertEqual(accessBridge(leader)._generation, null, "team-leader keeps no generation record");
    assertEqual(leader.getWorkflowRecorder(), null, "team-leader getWorkflowRecorder() is null");
  } finally {
    await leader.dispose();
  }
  assertNoUnhandledRejections();
});

await run("locked close order: disposeAll runs BEFORE detachForegroundGroupsForSession, then plan -> runner -> session -> mcp", async () => {
  const service = makeTaskService();
  const bridge = new SessionBridge({ agentTaskService: service });
  await bridge.start(makeLocation());
  const b = accessBridge(bridge);
  const generation = b._generation!;
  const session = b._session!;

  const order: string[] = [];
  const engine = generation.workflowEngine as unknown as { disposeAll: () => Promise<void> };
  const origDisposeAll = engine.disposeAll;
  engine.disposeAll = () => {
    order.push("disposeAll");
    return origDisposeAll.call(generation.workflowEngine);
  };
  const serviceAccess = service as unknown as { detachForegroundGroupsForSession: (sessionId: string) => unknown };
  const origDetach = serviceAccess.detachForegroundGroupsForSession;
  serviceAccess.detachForegroundGroupsForSession = (sessionId: string) => {
    order.push("detach");
    return origDetach.call(service, sessionId);
  };
  const planAccess = generation.planController as unknown as { dispose: () => Promise<void> };
  const origPlanDispose = planAccess.dispose;
  planAccess.dispose = () => {
    order.push("plan");
    return origPlanDispose.call(generation.planController);
  };
  const runnerAccess = generation.runner as unknown as { dispose: () => Promise<void> };
  const origRunnerDispose = runnerAccess.dispose;
  runnerAccess.dispose = () => {
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

  try {
    await bridge.dispose();
    assertEqual(
      order.join("->"),
      "disposeAll->detach->plan->runner->session->mcp",
      "locked close order: disposeAll before detach, then plan -> runner -> session -> mcp",
    );
  } finally {
    engine.disposeAll = origDisposeAll;
    serviceAccess.detachForegroundGroupsForSession = origDetach;
    planAccess.dispose = origPlanDispose;
    runnerAccess.dispose = origRunnerDispose;
    sessionAccess.dispose = origSessionDispose;
    mcpAccess.dispose = origMcpDispose;
  }
  assertNoUnhandledRejections();
});

await run("candidate disposal (bind failure) also runs disposeAll BEFORE detachForegroundGroupsForSession", async () => {
  const service = makeTaskService();
  const order: string[] = [];
  const serviceAccess = service as unknown as { detachForegroundGroupsForSession: (sessionId: string) => unknown };
  const origDetach = serviceAccess.detachForegroundGroupsForSession;
  serviceAccess.detachForegroundGroupsForSession = (sessionId: string) => {
    order.push("detach");
    return origDetach.call(service, sessionId);
  };
  // The engine instance is created inside the failing start(), so spy the
  // class prototype - the same instance method the candidate path resolves.
  const engineProto = WorkerThreadWorkflowEngine.prototype as unknown as { disposeAll: () => Promise<void> };
  const origDisposeAll = engineProto.disposeAll;
  engineProto.disposeAll = function (this: WorkerThreadWorkflowEngine): Promise<void> {
    order.push("disposeAll");
    return origDisposeAll.call(this);
  };
  const origBind = AgentSession.prototype.bindExtensions;
  (AgentSession.prototype as {
    bindExtensions: (bindings: Parameters<AgentSession["bindExtensions"]>[0]) => Promise<unknown>;
  }).bindExtensions = async function (this: AgentSession, bindings: Parameters<AgentSession["bindExtensions"]>[0]) {
    throw new Error("bind failed");
  };

  try {
    const bridge = new SessionBridge({ agentTaskService: service });
    let startError: string | undefined;
    try {
      await bridge.start(makeLocation());
    } catch (err) {
      startError = err instanceof Error ? err.message : String(err);
    }
    assertEqual(startError, "bind failed", "start rejects when bindExtensions throws");
    assertEqual(order.join("->"), "disposeAll->detach", "candidate disposal runs disposeAll BEFORE detachForegroundGroupsForSession");
    const b = accessBridge(bridge);
    assertEqual(b._generation, null, "generation cleared after activation failure");
    assertEqual(b._session, null, "session cleared after activation failure");
    assertEqual(b._mcpAdapter, null, "MCP adapter cleared after activation failure");
    assertEqual(bridge.getWorkflowRecorder(), null, "no workflow recorder after activation failure");
  } finally {
    (AgentSession.prototype as {
      bindExtensions: (bindings: Parameters<AgentSession["bindExtensions"]>[0]) => Promise<unknown>;
    }).bindExtensions = origBind;
    engineProto.disposeAll = origDisposeAll;
    serviceAccess.detachForegroundGroupsForSession = origDetach;
  }
  assertNoUnhandledRejections();
});

await run("getParentRef carries workspaceIdOf(cwd); config.cache is WorkflowChildCache at getAgentDir()/workflow-cache", async () => {
  const bridge = new SessionBridge({ agentTaskService: makeTaskService() });
  await bridge.start(makeLocation());
  const b = accessBridge(bridge);
  const generation = b._generation!;
  try {
    const engine = generation.workflowEngine as unknown as {
      cache?: WorkflowChildCache & { rootDir: string };
      start: (request: WorkflowStartRequest) => unknown;
    };
    assert(engine.cache instanceof WorkflowChildCache, "engine config.cache is a WorkflowChildCache");
    assertEqual(
      engine.cache.rootDir,
      join(getAgentDir(), "workflow-cache"),
      "cache rootDir is join(getAgentDir(), \"workflow-cache\")",
    );

    const session = b._session!;
    const workflowTool = session.getToolDefinition("workflow");
    assert(workflowTool !== undefined, "solo parent has a workflow tool definition");
    const origStart = engine.start;
    let capturedWorkspaceId: string | undefined;
    let capturedToolCallId: string | undefined;
    engine.start = (request: WorkflowStartRequest) => {
      capturedWorkspaceId = request.parent.workspaceId;
      capturedToolCallId = request.parent.toolCallId;
      throw new Error("stop-before-worker");
    };
    try {
      await workflowTool.execute(
        "call-ws",
        { script: "return 1;", meta: { name: "audit", description: "Audit" } } as never,
        undefined,
        undefined,
        undefined as never,
      );
      assert(false, "execute should throw after capturing parent");
    } catch (err) {
      assertEqual(
        err instanceof Error ? err.message : String(err),
        "stop-before-worker",
        "execute reached engine.start with parent ref",
      );
    } finally {
      engine.start = origStart;
    }
    assertEqual(capturedWorkspaceId, workspaceIdOf(PROJECT_CWD), "getParentRef.workspaceId is workspaceIdOf(cwd)");
    assertEqual(capturedToolCallId, "call-ws", "getParentRef.toolCallId is the tool call id");
  } finally {
    await bridge.dispose();
  }
  assertNoUnhandledRejections();
});

await run("recorder lifecycle is the only productEventCollector.record source; payload is status/durationMs/counts only", async () => {
  const recorded: ProductEvent[] = [];
  const fakeCollector = { record: (event: ProductEvent) => { recorded.push(event); } } as unknown as ProductEventCollector;
  const bridge = new SessionBridge({ agentTaskService: makeTaskService(), productEventCollector: fakeCollector });
  await bridge.start(makeLocation());
  try {
    const recorder = bridge.getWorkflowRecorder()!;
    assert(recorder !== null, "solo generation exposes a workflow recorder");

    const run1 = WorkflowRunId("wf-run-1");
    recorder.start({ id: run1, meta: { name: "audit", description: "Audit packages" } }, "call_1", "workflow");
    recorder.finish(run1, "completed");
    // WorkflowStopReason has no "failed": the recorder maps stopReason "error"
    // to the "failed" lifecycle event.
    const run2 = WorkflowRunId("wf-run-2");
    recorder.start({ id: run2, meta: { name: "ralph-loop", description: "Iterate" } }, "call_2", "ralph");
    recorder.finish(run2, "error");
    const run3 = WorkflowRunId("wf-run-3");
    recorder.start({ id: run3, meta: { name: "audit", description: "Audit packages" } }, "call_3", "workflow");
    recorder.finish(run3, "cancelled");

    assertEqual(
      recorded.map((event) => event.name).join(","),
      "workflow_started,workflow_completed,workflow_started,workflow_failed,workflow_started,workflow_cancelled",
      "started/completed/failed/cancelled map to the V143 workflow_* names",
    );
    assert(recorded.every((event) => event.schemaVersion === 1), "all recorded events carry schemaVersion 1");
    assertEqual(recorded[0]!.payload.status, "audit", "started payload carries the run name as status");
    const completed = recorded[1]!;
    assertEqual(completed.payload.status, "audit", "completed payload carries the run name as status");
    assertEqual(completed.payload.counts?.agentsStarted, 0, "completed payload counts agentsStarted");
    assert(typeof completed.payload.durationMs === "number" && completed.payload.durationMs >= 0, "completed payload carries durationMs");
    assertEqual(
      recorded.every((event) => Object.keys(event.payload).every((key) => ["status", "durationMs", "counts"].includes(key))),
      true,
      "payload carries only existing ProductEventPayload fields - never script/prompt/value",
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
